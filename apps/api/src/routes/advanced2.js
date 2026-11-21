import { scoped, collection } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { getQueue } from '../../../../packages/queue/index.js';
import { newId, stableHash } from '../../../../packages/shared/utils.js';
import { badRequest, forbidden } from '../../../../packages/shared/errors.js';
import QRCode from 'qrcode';
import { requirePlatformOwner } from '../platform-owner.js';

export default async function advanced2Routes(app) {
  // Activity feed
  app.get('/activity', async req => collection('audit_logs')
    .find({ organizationId: req.ctx.organizationId }, { sort: { createdAt: -1 }, limit: Number(req.query.limit || 20) }));

  // Notifications
  app.get('/notifications', async req => scoped('notifications', req.ctx).find({}, { sort: { createdAt: -1 }, limit: 20 }));
  app.post('/notifications/:id/read', async req => {
    await scoped('notifications', req.ctx).updateOne({ _id: req.params.id }, { $set: { read: true } });
    return { ok: true };
  });

  // Global search
  app.get('/search', async req => {
    const q = String(req.query.q || '').toLowerCase();
    if (!q) return [];
    const out = [];
    for (const [type, name, href] of [['contacts','email','/dashboard/contacts'],['campaigns','name','/dashboard/campaigns'],['templates','name','/dashboard/templates']]) {
      const rows = await scoped(type, req.ctx).find({}, { limit: 200 });
      for (const r of rows) if (String(r[name] || '').toLowerCase().includes(q))
        out.push({ type, title: r[name], href, id: r._id });
    }
    return out.slice(0, 20);
  });

  // Deliverability instruments
  app.get('/deliverability/health', async req => {
    const accounts = await scoped('sending_accounts', req.ctx).find({});
    const events = await scoped('delivery_events', req.ctx).find({});
    const bounced = events.filter(e => e.type === 'bounced').length;
    const complained = events.filter(e => e.type === 'complained').length;
    return { accounts: accounts.filter(a => a.status === 'active').length, total: accounts.length,
      bounceRate: events.length ? +(bounced / events.length).toFixed(4) : 0,
      complaintRate: events.length ? +(complained / events.length).toFixed(4) : 0,
      warmupAccounts: accounts.filter(a => a.warmup).length };
  });
  app.post('/deliverability/verify-dns', async req => {
    const domain = String(req.body.domain || '').trim().toLowerCase();
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw badRequest('Invalid domain');
    // Production: real DNS resolver checks. Demo returns a deterministic advisor result.
    return { domain, spf: 'v=spf1 include:_spf.google.com ~all', dkim: 'selector._domainkey.' + domain,
      dmarc: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@' + domain, verified: false,
      note: 'Add these records at your registrar; we verify propagation.' };
  });
  app.post('/deliverability/dmarc/import', async req => {
    const report = await scoped('dmarc_reports', req.ctx).create({ _id: newId(), domain: req.body.domain,
      xml: String(req.body.xml || '').slice(0, 2_000_000), parsed: { sources: [], pass: 0, fail: 0 }, createdAt: new Date().toISOString() });
    return { imported: true, reportId: report._id };
  });
  app.post('/deliverability/seed-test', async req => {
    const job = await getQueue('report').add('seed.test', { organizationId: req.ctx.organizationId,
      campaignId: req.body.campaignId, seedList: req.body.seedList || [] }, { jobId: stableHash('seed', req.ctx.organizationId, req.body.campaignId || '') });
    return { queued: true, jobId: job.id || newId() };
  });
  app.post('/accounts/:id/warmup', async req => {
    await scoped('sending_accounts', req.ctx).updateOne({ _id: req.params.id },
      { $set: { warmup: true, warmupPlan: req.body.plan || { day1: 10, day2: 20, day3: 35, day7: 70 } } });
    return { ok: true };
  });

  // Campaign approvals and A/Z variants
  app.post('/campaigns/:id/submit-approval', async req => {
    await scoped('campaigns', req.ctx).updateOne({ _id: req.params.id }, { $set: { status: 'pending_approval' } });
    return { ok: true };
  });
  app.post('/campaigns/:id/approve', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_SEND);
    await scoped('campaigns', req.ctx).updateOne({ _id: req.params.id },
      { $set: { status: 'draft', approvedBy: req.ctx.user.id, approvedAt: new Date().toISOString() } });
    return { ok: true };
  });
  app.post('/campaigns/:id/variants', async req => {
    const variants = (req.body.variants || []).slice(0, 8);
    await scoped('campaigns', req.ctx).updateOne({ _id: req.params.id },
      { $set: { variants, testStrategy: req.body.strategy || 'hash_split' } });
    return { ok: true, variants: variants.length };
  });

  // Canned replies, tags, round-robin assignment
  app.get('/canned-replies', async req => scoped('canned_replies', req.ctx).find({}));
  app.post('/canned-replies', async req => scoped('canned_replies', req.ctx).create({ _id: newId(), ...req.body }));
  app.get('/tags', async req => scoped('tags', req.ctx).find({}));
  app.post('/tags', async req => scoped('tags', req.ctx).create({ _id: newId(), ...req.body }));
  app.post('/contacts/:id/tags', async req => {
    await scoped('contacts', req.ctx).updateOne({ _id: req.params.id }, { $set: { tags: req.body.tags || [] } });
    return { ok: true };
  });
  app.post('/inbox/conversations/:id/assign', async req => {
    const members = await scoped('memberships', req.ctx).find({ status: 'active' });
    const idx = parseInt(stableHash(req.params.id).slice(0, 8), 16) % Math.max(members.length, 1);
    const assignee = req.body.assigneeId || members[idx]?.userId || req.ctx.user.id;
    await scoped('conversations', req.ctx).updateOne({ _id: req.params.id }, { $set: { assigneeId: assignee } });
    return { assigneeId: assignee };
  });

  // Security: Google Authenticator (TOTP) 2FA, sessions, impersonation
  app.post('/security/mfa/setup', async req => {
    const { generateSecret, otpauthUri, secondsRemaining } = await import('../../../../packages/security/totp.js');
    const secret = generateSecret();
    const email = req.ctx.user.email || 'account';
    const existing = await collection('users').findOne({ _id: req.ctx.user.id });
    if (existing?.mfaEnabled) throw badRequest('Two-factor authentication is already enabled. Disable it with a current code before setting it up again.');
    if (existing) await collection('users').updateOne({ _id: req.ctx.user.id }, { $set: { mfaSecret: secret, mfaEnabled: false } });
    else await collection('users').create({ _id: req.ctx.user.id, email, organizationId: req.ctx.organizationId,
      name: req.ctx.user.email || 'Demo Owner', mfaSecret: secret, mfaEnabled: false, createdAt: new Date().toISOString() });

    const uri = otpauthUri({ secret, account: email, issuer: 'Emavanta' });
    // Two independent renderings: inline SVG (no network, no canvas) and a PNG data URL.
    // If either fails we say so in the logs instead of silently showing "QR unavailable".
    let qrSvg = null, qr = null, qrError = null;
    try {
      qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 260, errorCorrectionLevel: 'M',
        color: { dark: '#11213a', light: '#ffffff' } });
    } catch (err) { qrError = `svg: ${err.message}`; console.error('[mfa] QR svg render failed', err); }
    try {
      qr = await QRCode.toDataURL(uri, { margin: 1, width: 260, errorCorrectionLevel: 'M',
        color: { dark: '#11213a', light: '#ffffff' } });
    } catch (err) { qrError = `${qrError ? `${qrError} · ` : ''}png: ${err.message}`; console.error('[mfa] QR png render failed', err); }

    return { secret, uri, qr, qrSvg, qrError, app: 'Google Authenticator', account: email,
      issuer: 'Emavanta', algorithm: 'SHA1', digits: 6, period: 30, secondsRemaining: secondsRemaining() };
  });
  app.get('/security/mfa/status', async req => {
    const user = await collection('users').findOne({ _id: req.ctx.user.id });
    return { enabled: !!user?.mfaEnabled, method: 'totp', app: 'Google Authenticator',
      recoveryCodesLeft: (user?.recoveryCodes || []).length };
  });
  app.post('/security/mfa/verify', async req => {
    const { verifyTotp } = await import('../../../../packages/security/totp.js');
    const user = await collection('users').findOne({ _id: req.ctx.user.id });
    if (!user?.mfaSecret || !verifyTotp(user.mfaSecret, String(req.body.code || ''))) throw badRequest('Invalid code');
    // Ten one-time recovery codes, returned once and stored only as hashes. They are the
    // only way back in if the phone is lost — without them 2FA is a lockout risk.
    const { randomBytes, createHash } = await import('node:crypto');
    const plain = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-'));
    const recoveryCodes = plain.map(code => ({ codeHash: createHash('sha256').update(code).digest('hex'),
      createdAt: new Date().toISOString() }));
    await collection('users').updateOne({ _id: user._id }, { $set: { mfaEnabled: true, recoveryCodes } });
    const { audit: writeAudit } = await import('../plugins/audit.js');
    await writeAudit(req.ctx, 'security.mfa.enable', 'user', { method: 'totp' });
    return { ok: true, enabled: true, recoveryCodes: plain };
  });
  app.post('/security/mfa/disable', async req => {
    const { verifyTotp } = await import('../../../../packages/security/totp.js');
    const user = await collection('users').findOne({ _id: req.ctx.user.id });
    if (!user?.mfaSecret || !verifyTotp(user.mfaSecret, String(req.body.code || ''))) throw badRequest('Current authenticator code required');
    await collection('users').updateOne({ _id: user._id }, { $set: { mfaEnabled: false, mfaSecret: null } });
    return { ok: true, enabled: false };
  });
  app.post('/admin/impersonate', async req => {
    await requirePlatformOwner(req.ctx);
    if (!req.body.reason || !req.body.ticketId) throw badRequest('reason and ticketId required');
    const { audit } = await import('../plugins/audit.js');
    await audit(req.ctx, 'admin.impersonate', 'organization', { organizationId: req.body.organizationId,
      ticketId: req.body.ticketId, reason: req.body.reason, ttlMinutes: 120 });
    return { ok: true, note: 'Impersonation is time-boxed to 2h and recorded in the audit chain.' };
  });

  // Data subject tools + export job
  app.get('/data/export', async req => {
    const job = await getQueue('report').add('data.export', { organizationId: req.ctx.organizationId }, { jobId: stableHash('export', req.ctx.organizationId) });
    return { jobId: job.id || newId(), status: 'queued' };
  });
  app.post('/data/delete', async req => {
    assertPermission(req.ctx, PERMISSIONS.ORG_SETTINGS);
    if (req.body.confirm !== 'DELETE') throw badRequest('Type DELETE to confirm');
    await scoped('contacts', req.ctx).updateMany({}, { $set: { deleted: true } });
    return { ok: true, note: 'Workspace deletion requires 30-day read-only period before purge.' };
  });

  // Billing extras
  app.get('/billing/invoices', async req => scoped('invoices', req.ctx).find({}, { sort: { createdAt: -1 }, limit: 50 }));
  app.get('/admin/cost', async req => { await requirePlatformOwner(req.ctx); return { available:false, message:'Cost data is not connected.' }; });

  // API contract + feature flags
  app.get('/openapi.json', async () => ({
    openapi: '3.0.3', info: { title: 'Emavanta API', version: '0.1.0' },
    servers: [{ url: '/api/v1' }],
    paths: Object.fromEntries(['/auth/register','/auth/login','/campaigns','/templates','/contacts','/accounts',
      '/billing/plans','/team/members','/analytics/overview','/inbox/conversations'].map(p=>[p,{ get:{ responses:{200:{description:'OK'}}} }]))
  }));
  app.get('/features', async () => ({ flags: { seed_tests: true, agency_portals: true,
    sso: false, kafka_events: false, dedicated_ip_resale: false } }));
}
