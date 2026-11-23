import { registerSchema, loginSchema } from '../../../../packages/validation/index.js';
import { hashPassword, verifyPassword } from '../../../../packages/security/password.js';
import { signSession } from '../../../../packages/security/token.js';
import { collection } from '../../../../packages/database/store.js';
import { newId } from '../../../../packages/shared/utils.js';
import { unauthorized, conflict, badRequest, notFound, tooMany, AppError } from '../../../../packages/shared/errors.js';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { sendVerificationCode, sendWelcomeMail, sendResetMail, sendPasswordChangedMail, smtpConfigured } from '../mail-auth.js';
import { audit } from '../plugins/audit.js';
import { config } from '../config.js';
import { sessionNotExpired, sessionExpiresAt } from '../../../../packages/security/session-policy.js';
import { ensureWorkspaceDefaultContent } from '../../../../packages/onboarding/defaultContent.js';

const demo = () => process.env.DEMO_MODE === 'true' && process.env.NODE_ENV === 'test';
const publicUser = u => ({ id: u._id || u.id, email: u.email, name: u.name,
  emailVerified: u.emailVerified !== false });

/** One-handed token helper: the raw value goes to the user, only its hash is stored. */
const issueToken = () => {
  const raw = randomBytes(24).toString('hex');
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
};
const hashOf = raw => createHash('sha256').update(String(raw || '')).digest('hex');

const DEVICE = ua => {
  const s = String(ua || '');
  const os = /Windows/i.test(s) ? 'Windows' : /Macintosh|Mac OS/i.test(s) ? 'macOS'
    : /Android/i.test(s) ? 'Android' : /iPhone|iPad|iOS/i.test(s) ? 'iOS' : /Linux/i.test(s) ? 'Linux' : 'Unknown OS';
  const browser = /Edg\//i.test(s) ? 'Edge' : /Chrome\//i.test(s) ? 'Chrome' : /Firefox\//i.test(s) ? 'Firefox'
    : /Safari\//i.test(s) ? 'Safari' : 'API client';
  return `${browser} · ${os}`;
};

/** Every sign-in creates a real, revocable session so Security shows true device state. */
const startSession = async ({ req, user, role, orgId, membershipId, scopes = [], mfaVerified = false }) => {
  const sid = newId();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + config.sessionTtlDays * 86_400_000).toISOString();
  await collection('sessions').create({ _id: sid, sid, userId: user._id || user.id, organizationId: orgId,
    membershipId: membershipId || null, role, mfaVerified, familyId: sid, status: 'active', device: DEVICE(req.headers['user-agent']),
    userAgent: req.headers['user-agent'] || 'unknown', ip: req.ip || 'local', createdAt, lastSeenAt: createdAt,
    persistent: true, expiresAt, tokenHash: null });
  return { sid, expiresAt };
};

const sessionFor = (user, role, orgId, membershipId, scopes = [], session = {}) => signSession({
  sub: user._id || user.id, email: user.email, role, org: orgId, membershipId, workspaceScopes: scopes,
  sid: session.sid, exp: Math.floor(Date.parse(session.expiresAt) / 1000)
});

/** Creates (or refreshes) the email-verification token for a user. */
async function createVerification({ user }) {
  const { raw, hash } = issueToken();
  const now = new Date().toISOString();
  await collection('email_verifications').create({ _id: newId(), userId: user._id || user.id,
    email: user.email, tokenHash: hash, status: 'pending', createdAt: now,
    expiresAt: new Date(Date.now() + 24 * 3600e3).toISOString() });
  return { raw };
}

// A challenge token binds the OTP to this browser. Only hashes are stored.
async function issueEmailChallenge(user) {
  const col = collection('signup_otps');
  const recent = await col.find({ userId: user._id, createdAt: { $gte: new Date(Date.now() - 3600e3).toISOString() } });
  if (recent.length >= 8) throw tooMany('Too many codes requested. Please try again later.');
  const lastRequest = Math.max(0, ...recent.map(r => Date.parse(r.createdAt) || 0));
  const retryAfterSeconds = Math.max(0, Math.ceil((lastRequest + 60_000 - Date.now()) / 1000));
  if (retryAfterSeconds) throw new AppError(429, 'RATE_LIMITED', `Please wait ${retryAfterSeconds} seconds before requesting another code.`, { retryAfterSeconds });
  await col.updateMany({ userId: user._id, status: 'pending' }, { $set: { status: 'superseded' } });
  const token = issueToken();
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const created = await col.create({ _id: newId(), userId: user._id, challengeHash: token.hash,
    codeHash: hashOf(`${token.raw}:${code}`), status: 'pending', attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString() });
  const delivery = await sendVerificationCode(user.email, code);
  const result = { verificationRequired: true, challengeToken: token.raw, email: user.email, resendAvailableAt: new Date(Date.parse(created.createdAt) + 60_000).toISOString(), retryAfterSeconds: Math.max(0, Math.ceil((Date.parse(created.createdAt) + 60_000 - Date.now()) / 1000)) };
  if (delivery.deliveryError) throw new AppError(424, 'EMAIL_DELIVERY_FAILED', delivery.deliveryError, result);
  return { ...result, sent: true };
}

export default async function authRoutes(app) {
  /** Registration creates an unverified account; a session is issued only after OTP. */
  app.post('/auth/register', async req => {
    const input = registerSchema.parse(req.body);
    const users = collection('users');
    if (await users.findOne({ email: input.email })) throw conflict('Email already registered');
    const now = new Date().toISOString();
    const userId = newId(), orgId = newId();
    const user = await users.create({ _id: userId, email: input.email, name: input.name,
      passwordHash: await hashPassword(input.password), emailVerified: false, mfaEnabled: false, createdAt: now });
    const org = await collection('organizations').create({ _id: orgId, name: input.organization, plan: 'free', planStartedAt: now, planChangeSource:'free',
      cycle: `cycle-${now.slice(0,7)}`, ownerId: userId,
      settings: { timezone: 'UTC', brandName: input.organization }, createdAt: now });
    const membership = await collection('memberships').create({ _id: newId(), userId,
      organizationId: orgId, role: 'owner', status: 'active', workspaceScopes: [] });
    await audit({ user: { id: userId }, organizationId: orgId }, 'auth.register', 'user');
    return issueEmailChallenge(user);
  });

  /** One stable development/testing login — seeded demo workspace, no external services. */
  app.post('/auth/demo-login', async req => {
    if (!demo()) throw unauthorized('Demo login is only available in development mode');
    const user = { _id: 'demo-user', email: 'demo@emavanta.local', name: 'Demo Owner', emailVerified: true };
    await ensureWorkspaceDefaultContent({ organizationId: 'demo-org' });
    const session = await startSession({ req, user, role: 'owner', orgId: 'demo-org', membershipId: 'demo-membership' });
    const token = sessionFor(user, 'owner', 'demo-org', 'demo-membership', [], session);
    await audit({ user: { id: user._id }, organizationId: 'demo-org' }, 'auth.demo_login', 'user', { ip: req.ip });
    return { token, user: publicUser(user), organizationId: 'demo-org', role: 'owner', demo: true };
  });

  app.post('/auth/login', async req => {
    const input = loginSchema.parse(req.body);
    const user = await collection('users').findOne({ email: input.email });
    if (!user || !(await verifyPassword(user.passwordHash, input.password))) throw unauthorized('Email or password is not correct. Check both and try again.');
    if (['suspended','deleted'].includes(user.platformStatus)) throw unauthorized('This account is not active. Contact support.');
    const membership = await collection('memberships').findOne({ userId: user._id, status: 'active' });
    if (!membership) throw unauthorized('No active membership');
    if (user.emailVerified === false) return issueEmailChallenge(user);

    // Two-factor: the password alone opens nothing. A short-lived challenge is stored and
    // the client must post the 6-digit code to /auth/login/mfa to get a session.
    if (user.mfaEnabled) {
      const challenge = issueToken();
      const now = new Date().toISOString();
      await collection('login_challenges').create({ _id: newId(), userId: user._id, challengeHash: challenge.hash,
        status: 'pending', createdAt: now, expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
        userAgent: req.headers['user-agent'] || 'unknown', ip: req.ip || 'local' });
      await audit({ user: { id: user._id }, organizationId: membership.organizationId }, 'auth.login.mfa_challenge', 'user');
      return { mfaRequired: true, challengeToken: challenge.raw, method: 'totp',
        message: 'Enter the 6-digit code from your authenticator app.' };
    }

    await ensureWorkspaceDefaultContent({ organizationId: membership.organizationId });
    const session = await startSession({ req, user, role: membership.role, orgId: membership.organizationId,
      membershipId: membership._id, scopes: membership.workspaceScopes || [] });
    const token = sessionFor(user, membership.role, membership.organizationId, membership._id, membership.workspaceScopes || [], session);
    return { token, user: publicUser(user), organizationId: membership.organizationId, role: membership.role };
  });

  app.post('/auth/verify-otp', async req => {
    const token = String(req.body?.challengeToken || '');
    const code = String(req.body?.code || '').trim();
    if (!/^[0-9a-f]{48}$/.test(token) || !/^\d{6}$/.test(code)) throw badRequest('Enter the six-digit email code.');
    const col = collection('signup_otps');
    const row = await col.findOne({ challengeHash: hashOf(token), status: 'pending' });
    if (!row || Date.parse(row.expiresAt) <= Date.now() || (row.attempts || 0) >= 5)
      throw badRequest('This code expired or has too many attempts. Request a new code.');
    // Atomically consume an attempt before comparing so concurrent guesses cannot bypass the limit.
    const attempt = await col.updateOne({ _id: row._id, status: 'pending', attempts: { $lt: 5 } }, { $inc: { attempts: 1 } });
    if (!attempt.matchedCount) throw badRequest('This code is no longer valid. Request a new code.');
    if (hashOf(`${token}:${code}`) !== row.codeHash) throw badRequest('That code is incorrect. Check your email and try again.');
    const claim = await col.updateOne({ _id: row._id, status: 'pending' }, { $set: { status: 'used', usedAt: new Date().toISOString() } });
    if (!claim.matchedCount) throw badRequest('This code has already been used.');
    const user = await collection('users').findOne({ _id: row.userId });
    const membership = user && await collection('memberships').findOne({ userId: user._id, status: 'active' });
    if (!user || !membership || ['suspended','deleted'].includes(user.platformStatus)) throw unauthorized('Sign in again.');
    await collection('users').updateOne({ _id: user._id }, { $set: { emailVerified: true, emailVerifiedAt: new Date().toISOString() } });
    await ensureWorkspaceDefaultContent({ organizationId: membership.organizationId });
    // Welcome is best-effort: verification remains successful if this separate message fails.
    void sendWelcomeMail(user.email);
    if (user.mfaEnabled) {
      const challenge = issueToken();
      await collection('login_challenges').create({ _id: newId(), userId: user._id, challengeHash: challenge.hash,
        status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5 * 60000).toISOString() });
      return { mfaRequired: true, challengeToken: challenge.raw, method: 'totp' };
    }
    const session = await startSession({ req, user, role: membership.role, orgId: membership.organizationId, membershipId: membership._id,
      scopes: membership.workspaceScopes || [] });
    const sessionToken = sessionFor(user, membership.role, membership.organizationId, membership._id, membership.workspaceScopes || [], session);
    return { token: sessionToken, user: publicUser({ ...user, emailVerified: true }), organizationId: membership.organizationId, role: membership.role };
  });

  app.post('/auth/verify-otp/resend', async req => {
    const token = String(req.body?.challengeToken || '');
    if (!/^[0-9a-f]{48}$/.test(token)) throw badRequest('Sign in again to request a code.');
    const row = await collection('signup_otps').findOne({ challengeHash: hashOf(token), status: 'pending' });
    if (!row || Date.now() - Date.parse(row.createdAt) > 3600e3) throw badRequest('Sign in again to request a code.');
    const user = await collection('users').findOne({ _id: row.userId, emailVerified: false });
    if (!user || ['suspended','deleted'].includes(user.platformStatus)) throw badRequest('Sign in again to continue.');
    return issueEmailChallenge(user);
  });

  /** Second step of a two-factor sign-in. Also accepts a one-time recovery code. */
  app.post('/auth/login/mfa', async req => {
    const { challengeToken, code } = req.body || {};
    if (!challengeToken) throw badRequest('Sign in again — the code step expired.');
    const challenge = await collection('login_challenges').findOne({ challengeHash: hashOf(challengeToken) });
    if (!challenge || challenge.status !== 'pending') {
      throw unauthorized('This sign-in attempt expired. Enter your password again.');
    }
    if (Date.parse(challenge.expiresAt) < Date.now()) {
      await collection('login_challenges').updateOne({ _id: challenge._id }, { $set: { status: 'expired' } });
      throw unauthorized('The code step expired after five minutes. Sign in again.');
    }
    const user = await collection('users').findOne({ _id: challenge.userId });
    if (!user || ['suspended','deleted'].includes(user.platformStatus)) throw unauthorized('Sign in again.');

    const { verifyTotp } = await import('../../../../packages/security/totp.js');
    const supplied = String(code || '').replace(/\s/g, '');
    let ok = !!user.mfaSecret && verifyTotp(user.mfaSecret, supplied);
    let usedRecovery = false;
    if (!ok) {
      // Recovery codes are single use: a match is consumed immediately.
      const codes = user.recoveryCodes || [];
      const index = codes.findIndex(c => String(c.codeHash || c).length && String(c.codeHash || '') === hashOf(supplied));
      if (index >= 0 && supplied.length >= 8) {
        ok = true; usedRecovery = true;
        const next = codes.slice(); next.splice(index, 1);
        await collection('users').updateOne({ _id: user._id }, { $set: { recoveryCodes: next } });
      }
    }
    if (!ok) {
      await collection('login_challenges').updateOne({ _id: challenge._id },
        { $set: { attempts: (challenge.attempts || 0) + 1 } });
      throw unauthorized('That code is not valid. Check the app and try the next one.');
    }

    await collection('login_challenges').updateOne({ _id: challenge._id },
      { $set: { status: 'used', usedAt: new Date().toISOString() } });
    const membership = await collection('memberships').findOne({ userId: user._id, status: 'active' });
    if (!membership) throw unauthorized('No active membership');
    await ensureWorkspaceDefaultContent({ organizationId: membership.organizationId });
    const session = await startSession({ req, user, role: membership.role, orgId: membership.organizationId,
      membershipId: membership._id, scopes: membership.workspaceScopes || [], mfaVerified: true });
    const token = sessionFor(user, membership.role, membership.organizationId, membership._id, membership.workspaceScopes || [], session);
    await audit({ user: { id: user._id }, organizationId: membership.organizationId },
      usedRecovery ? 'auth.login.recovery_code' : 'auth.login.mfa', 'user');
    return { token, user: publicUser(user), organizationId: membership.organizationId, role: membership.role,
      usedRecovery, remainingRecovery: (user.recoveryCodes || []).length - (usedRecovery ? 1 : 0) };
  });

  app.get('/auth/me', async req => {
    const ctx = req.ctx;
    const user = ctx?.demo ? { _id: 'demo-user', email: 'demo@emavanta.local', name: 'Demo Owner', emailVerified: true }
      : await collection('users').findOne({ _id: ctx.user.id });
    const org = ctx?.demo ? { _id: 'demo-org', name: 'Demo Org', plan: 'growth' }
      : await collection('organizations').findOne({ _id: ctx.organizationId });
    return { user: user ? publicUser(user) : null,
      organization: org ? { id: org._id, name: org.name, plan: org.plan } : null,
      role: ctx?.user?.role, demo: !!ctx?.demo };
  });

  /* ------------------------------------------------------------------ */
  /* Signing out, verifying an address, and recovering a password        */
  /* ------------------------------------------------------------------ */

  /** Ends *this* device's session. The token stops working immediately. */
  app.post('/auth/logout', async req => {
    if (req.ctx?.sessionId) {
      await collection('sessions').updateOne({ _id: req.ctx.sessionId, organizationId: req.ctx.organizationId },
        { $set: { status: 'revoked', revokedAt: new Date().toISOString(), revokedReason: 'logout' } });
    }
    await audit(req.ctx, 'auth.logout', 'session', {});
    return { ok: true };
  });

  /** Ends every session for this person, on every device and workspace. */
  app.post('/auth/logout-all', async req => {
    const userId = req.ctx?.user?.id;
    if (!userId) throw unauthorized('Sign in first');
    const rows = await collection('sessions').find({ userId, status: 'active' });
    for (const row of rows) {
      await collection('sessions').updateOne({ _id: row._id },
        { $set: { status: 'revoked', revokedAt: new Date().toISOString(), revokedReason: 'logout_all' } });
    }
    await audit(req.ctx, 'auth.logout_all', 'session', { revoked: rows.length });
    return { ok: true, revoked: rows.length };
  });

  /** Who is signed in where — shown on Security and on Team. */
  app.get('/auth/sessions', async req => {
    const rows = await collection('sessions').find({ userId: req.ctx.user.id, status: 'active' },
      { sort: { createdAt: -1 }, limit: 100 });
    const now = Date.now(), active = [];
    for (const row of rows) {
      if (!sessionNotExpired(row, now, config.sessionTtlDays)) {
        await collection('sessions').updateOne({ _id: row._id, status: 'active' },
          { $set: { status: 'expired', expiredAt: new Date(now).toISOString(), revokedReason: 'ttl_expired' } });
        continue;
      }
      const { tokenHash, ...rest } = row;
      active.push({ ...rest, expiresAt: sessionExpiresAt(row, config.sessionTtlDays),
        sid: rest._id, current: rest._id === req.ctx.sessionId,
        label: rest.userAgent || rest.device || 'Browser' });
    }
    return active;
  });

  /** Sends (dev: shows) a fresh verification link. Never reveals whether the address exists. */
  app.post('/auth/verify/send', async req => {
    const userId = req.ctx?.user?.id;
    if (!userId) throw unauthorized('Sign in first');
    const user = await collection('users').findOne({ _id: userId });
    if (!user) throw unauthorized('Sign in first');
    if (user.emailVerified) return { ok: true, alreadyVerified: true };
    throw badRequest('Sign in again to request an email verification code.');
  });

  app.get('/auth/verify/status', async req => {
    if (req.ctx?.demo) return { emailVerified: true, demo: true };
    const user = await collection('users').findOne({ _id: req.ctx.user.id });
    return { emailVerified: user?.emailVerified !== false, email: user?.email, name: user?.name };
  });

  app.post('/auth/verify/confirm', async req => {
    const raw = String(req.body?.token || '').trim();
    if (!raw) throw badRequest('That verification link is missing its token');
    const row = await collection('email_verifications').findOne({ tokenHash: hashOf(raw), status: 'pending' });
    if (!row) throw badRequest('This verification link is no longer valid — send a new one');
    if (Date.parse(row.expiresAt) < Date.now()) {
      await collection('email_verifications').updateOne({ _id: row._id }, { $set: { status: 'expired' } });
      throw badRequest('This verification link has expired — send a new one');
    }
    await collection('email_verifications').updateOne({ _id: row._id },
      { $set: { status: 'used', usedAt: new Date().toISOString() } });
    await collection('users').updateOne({ _id: row.userId }, { $set: { emailVerified: true, emailVerifiedAt: new Date().toISOString() } });
    await audit({ userId: row.userId }, 'auth.verify.confirmed', 'user', { email: row.email });
    return { ok: true, email: row.email };
  });

  /** Always answers the same way — it never leaks which addresses have accounts. */
  app.post('/auth/password/forgot', async req => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter the email you signed up with');
    if (!smtpConfigured()) throw new AppError(424, 'EMAIL_UNAVAILABLE', 'Email service is not configured. Contact support and try again.');
    const cutoff = new Date(Date.now() - 15 * 60000).toISOString();
    const emailHash = hashOf(email);
    const recent = await collection('password_reset_requests').find({ createdAt: { $gte: cutoff }, requestedIp: req.ip || 'unknown' });
    if (recent.length >= 12) throw tooMany('Too many requests. Please wait and try again.');
    const forAddress = await collection('password_reset_requests').countDocuments({ emailHash, createdAt: { $gte: cutoff } });
    if (forAddress >= 4) throw tooMany('Too many requests. Please wait and try again.');
    await collection('password_reset_requests').create({ _id: newId(), emailHash, requestedIp: req.ip || 'unknown' });
    const base = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
    if (!/^https?:\/\//i.test(base)) throw new AppError(424, 'EMAIL_UNAVAILABLE', 'Password recovery is temporarily unavailable. Contact support.');
    const answer = { ok: true, message: 'If an account exists, check your inbox and spam folder for a reset link. If it does not arrive, try again later or contact support.' };
    const user = await collection('users').findOne({ email });
    if (!user) return answer;
    const { raw, hash } = issueToken();
    const reset = await collection('password_resets').create({ _id: newId(), userId: user._id, email,
      tokenHash: hash, status: 'pending', requestedIp: req.ip || null,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    const delivery = await sendResetMail(email, `${base}/reset-password#token=${encodeURIComponent(raw)}`);
    if (delivery.deliveryError) await collection('password_resets').updateOne({ _id: reset._id }, { $set: { status: 'delivery_failed' } });
    else await audit({ userId: user._id }, 'auth.password.forgot', 'user', { email });
    // Keep the same response for known and unknown accounts, including on SMTP failure.
    return answer;
  });

  const checkReset = async rawValue => {
    const raw = String(rawValue || '').trim();
    if (!raw) return { valid: false, reason: 'missing' };
    const row = await collection('password_resets').findOne({ tokenHash: hashOf(raw), status: 'pending' });
    if (!row) return { valid: false, reason: 'not_found' };
    if (Date.parse(row.expiresAt) < Date.now()) return { valid: false, reason: 'expired' };
    return { valid: true, email: row.email };
  };
  app.post('/auth/password/reset/check', async req => checkReset(req.body?.token));
  // Old links/clients remain supported; new links put the token in the URL fragment.
  app.get('/auth/password/reset/check', async req => checkReset(req.query?.token));

  app.post('/auth/password/reset', async req => {
    const raw = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    if (!raw) throw badRequest('That reset link is missing its token');
    if (password.length < 10) throw badRequest('Use at least 10 characters for the new password');
    const row = await collection('password_resets').findOne({ tokenHash: hashOf(raw), status: 'pending' });
    if (!row) throw badRequest('This reset link is no longer valid — request a new one');
    if (Date.parse(row.expiresAt) < Date.now()) {
      await collection('password_resets').updateOne({ _id: row._id }, { $set: { status: 'expired' } });
      throw badRequest('This reset link has expired — request a new one');
    }
    const claim = await collection('password_resets').updateOne({ _id: row._id, status: 'pending' }, { $set: { status: 'processing' } });
    if (!claim.matchedCount) throw badRequest('This reset link has already been used.');
    await collection('users').updateOne({ _id: row.userId }, { $set: {
      passwordHash: await hashPassword(password), passwordChangedAt: new Date().toISOString() } });
    await collection('password_resets').updateOne({ _id: row._id, status: 'processing' },
      { $set: { status: 'used', usedAt: new Date().toISOString() } });
    await collection('password_resets').updateMany({ userId: row.userId, status: 'pending' }, { $set: { status: 'superseded' } });
    // a password change signs out every existing session
    const sessions = await collection('sessions').find({ userId: row.userId, status: 'active' });
    for (const s of sessions) {
      await collection('sessions').updateOne({ _id: s._id },
        { $set: { status: 'revoked', revokedAt: new Date().toISOString(), revokedReason: 'password_reset' } });
    }
    void sendPasswordChangedMail(row.email);
    await audit({ userId: row.userId }, 'auth.password.reset', 'user', { email: row.email, sessionsRevoked: sessions.length });
    return { ok: true, signedOutSessions: sessions.length };
  });
}
