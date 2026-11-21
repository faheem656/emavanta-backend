import { scoped, collection } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS, canAccessWorkspace } from '../../../../packages/security/rbac.js';
import { createOAuthState, googleAuthUrl, microsoftAuthUrl, exchangeCode } from '../../../../packages/security/oauth.js';
import { encryptCredentials } from '../../../../packages/providers/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { badRequest, notFound, forbidden, tooMany } from '../../../../packages/shared/errors.js';
import { acquireStream } from '../../../../packages/rate-limiter/index.js';
import { config } from '../config.js';
import { audit } from '../plugins/audit.js';

const oauthStates = new Map();

export default async function accountRoutes(app) {
  app.get('/accounts', async req => {
    const all = await scoped('sending_accounts', req.ctx).find({});
    return all.filter(a => canAccessWorkspace(req.ctx, a.workspaceId))
      .map(a => ({ ...a, encryptedCredentials: '[ENCRYPTED]', credentials: undefined }));
  });

  app.post('/accounts/oauth/start', async req => {
    assertPermission(req.ctx, PERMISSIONS.ACCOUNTS_CONNECT);
    if (process.env.NODE_ENV !== 'test') throw badRequest('OAuth connection is not available until verified sender identity is configured. Use SMTP instead.');
    const { provider } = req.body;
    if (!['google','microsoft'].includes(provider)) throw badRequest('provider must be google or microsoft');
    const { state, verifier, challenge } = createOAuthState();
    oauthStates.set(state, { verifier, org: req.ctx.organizationId, userId: req.ctx.user.id, provider, expires: Date.now() + 600000 });
    const redirectUri = `${config.oauthBase}/api/v1/accounts/oauth/callback`;
    const clientId = process.env[provider === 'google' ? 'GOOGLE_CLIENT_ID' : 'MICROSOFT_CLIENT_ID'] || 'demo-client';
    const url = provider === 'google' ? googleAuthUrl(clientId, redirectUri, { state, challenge })
      : microsoftAuthUrl(clientId, redirectUri, { state, challenge });
    return { url, state };
  });

  app.get('/accounts/oauth/callback', async req => {
    if (process.env.NODE_ENV !== 'test') throw badRequest('OAuth connection is not available yet.');
    const { state, code } = req.query;
    const saved = oauthStates.get(state);
    if (!saved || saved.expires < Date.now()) throw badRequest('Invalid or expired OAuth state');
    oauthStates.delete(state);
    const clientId = process.env[saved.provider === 'google' ? 'GOOGLE_CLIENT_ID' : 'MICROSOFT_CLIENT_ID'];
    const clientSecret = process.env[saved.provider === 'google' ? 'GOOGLE_CLIENT_SECRET' : 'MICROSOFT_CLIENT_SECRET'];
    let tokens;
    if (clientId && clientSecret) {
      tokens = await exchangeCode(saved.provider, { code, clientId, clientSecret,
        redirectUri: `${config.oauthBase}/api/v1/accounts/oauth/callback`, verifier: saved.verifier });
    } else {
      tokens = { access_token: 'demo-access', refresh_token: 'demo-refresh', expires_in: 3600 };
    }
    const ctx = { organizationId: saved.org, user: { id: saved.userId } };
    const account = await scoped('sending_accounts', ctx).create({ _id: newId(),
      authMethod: saved.provider, status: 'active', stream: 'outreach', shared: false,
      fromEmail: 'user@example.com', fromName: 'Connected user',
      encryptedCredentials: encryptCredentials({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        expiresAt: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString() }),
      sentToday: 0, dailyCap: 50, warmup: false });
    await audit(ctx, 'account.oauth_connect', 'sending_account', { provider: saved.provider });
    return { ok: true, accountId: account._id };
  });

  /**
   * Manual connection. Credentials are validated before anything is stored, and the
   * account is only marked active after a real handshake with the mail server.
   */
  app.post('/accounts/connect', async req => {
    assertPermission(req.ctx, PERMISSIONS.ACCOUNTS_CONNECT);
    const { method, fromEmail } = req.body;
    if (method === 'mock' && process.env.NODE_ENV !== 'test') throw badRequest('Demo mailboxes are not available.');
    if (!['smtp','esp_api','mock'].includes(method)) throw badRequest('Use /accounts/oauth/start for Google/Microsoft');
    if (!fromEmail || !/^\S+@\S+\.\S+$/.test(String(fromEmail))) throw badRequest('A valid from address is required');
    const c = req.body.credentials || {};
    const problems = [];
    if (method === 'smtp') {
      if (!c.host) problems.push('SMTP host');
      if (!c.user) problems.push('username');
      if (!c.pass) problems.push('password or app password');
    }
    if (method === 'esp_api') {
      if (!c.provider) problems.push('ESP provider');
      if (!c.apiKey) problems.push('API key');
    }
    if (problems.length) throw badRequest(`Missing: ${problems.join(', ')}`);
    if (method !== 'mock' && c.skipTest !== true) {
      const probe = { credentials: { host: c.host, port: c.port || 587, secure: !!c.secure, user: c.user, pass: c.pass } };
      if (method === 'smtp') {
        const { testSmtp } = await import('../../../../packages/providers/smtp.js');
        try { await testSmtp(probe); }
        catch (e) { throw badRequest(`Mail server rejected the credentials: ${e.message}`); }
      }
    }
    const status = method === 'mock' ? 'active' : (method === 'esp_api' || c.skipTest === true ? 'pending_verification' : 'active');
    const account = await scoped('sending_accounts', req.ctx).create({ _id: newId(), authMethod: method, status,
      stream: req.body.stream || 'outreach', fromEmail, fromName: req.body.fromName || '',
      smtpHost: method === 'smtp' ? c.host : undefined,
      shared: !!req.body.shared, workspaceId: req.body.workspaceId || null, dailyCap: req.body.dailyCap || 50,
      warmup: !!req.body.warmup, sentToday: 0, connectedAt: new Date().toISOString(),
      encryptedCredentials: encryptCredentials({ ...c, skipTest: undefined }) });
    await audit(req.ctx, 'account.connect', 'sending_account', { method, verified: status === 'active' });
    return { ...account, encryptedCredentials: '[ENCRYPTED]', verified: status === 'active',
      next: status === 'active' ? 'Send a test email to confirm delivery.' : 'Run a connection test to activate this mailbox.' };
  });

  app.post('/accounts/:id/test', async req => {
    assertPermission(req.ctx, PERMISSIONS.ACCOUNTS_CONNECT);
    const acc = await scoped('sending_accounts', req.ctx).findOne({ _id: req.params.id });
    if (!acc || !canAccessWorkspace(req.ctx,acc.workspaceId)) throw notFound('Account not found');
    const recipient=String(req.body?.to||acc.fromEmail||'').trim();
    if(recipient.length>254||!/^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/.test(recipient))throw badRequest('Provide a valid test recipient.');
    const limit=await acquireStream({organizationId:req.ctx.organizationId,stream:'transactional',accountId:acc._id,domain:String(acc.fromEmail||'').split('@')[1]||'unknown',streamCapacity:20,streamRefill:20/3600,accountCapacity:10,accountRefill:10/3600,domainCapacity:20,domainRefill:20/3600});
    if(!limit.ok)throw tooMany('Too many test messages. Please try again later.');
    const { sendMessage } = await import('../../../../packages/providers/index.js');
    try {
      await sendMessage(acc, { id: `test-${newId()}`, to: recipient, from: acc.fromEmail,
        subject: 'Emavanta connection test', html: '<p>Your mailbox is connected and ready to send.</p>' });
      await scoped('sending_accounts', req.ctx).updateOne({ _id: acc._id }, { $set: { status: 'active', lastError: null } });
      return { ok: true, status: 'active' };
    } catch (e) {
      await scoped('sending_accounts', req.ctx).updateOne({ _id: acc._id }, { $set: { status: 'error', lastError: e.message } });
      throw badRequest('Test email could not be sent. Check the mailbox configuration.');
    }
  });

  app.post('/accounts/:id/verify', async req => {
    assertPermission(req.ctx, PERMISSIONS.ACCOUNTS_CONNECT);
    const acc = await scoped('sending_accounts', req.ctx).findOne({ _id: req.params.id });
    if (!acc || !canAccessWorkspace(req.ctx,acc.workspaceId)) throw notFound('Account not found');
    const recipient=String(req.body?.to||acc.fromEmail||'').trim();
    if(recipient.length>254||!/^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/.test(recipient))throw badRequest('Provide a valid test recipient.');
    const limit=await acquireStream({organizationId:req.ctx.organizationId,stream:'transactional',accountId:acc._id,domain:String(acc.fromEmail||'').split('@')[1]||'unknown',streamCapacity:20,streamRefill:20/3600,accountCapacity:10,accountRefill:10/3600,domainCapacity:20,domainRefill:20/3600});
    if(!limit.ok)throw tooMany('Too many test messages. Please try again later.');
    const { sendMessage } = await import('../../../../packages/providers/index.js');
    try {
      await sendMessage(acc, { id: `verify-${newId()}`, to: recipient,
        from: acc.fromEmail, subject: 'Emavanta connection test', html: '<p>Your mailbox is connected.</p>' });
      await scoped('sending_accounts', req.ctx).updateOne({ _id: acc._id }, { $set: { status: 'active' } });
      return { ok: true };
    } catch (e) {
      await scoped('sending_accounts', req.ctx).updateOne({ _id: acc._id },
        { $set: { status: e.code === 'REAUTH_REQUIRED' ? 'reauth_required' : 'limited', lastError: e.message } });
      throw badRequest('Verification email could not be sent. Check the mailbox configuration.');
    }
  });

  /**
   * Edit the limits of a connected mailbox (send policy page). Only the fields the
   * user can reason about are accepted — credentials are never editable here.
   */
  app.patch('/accounts/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.ORG_SETTINGS);
    const account = await scoped('sending_accounts', req.ctx).findOne({ _id: req.params.id });
    if (!account) throw notFound('Mail account not found');
    const set = {};
    if (req.body.dailyCap !== undefined) {
      const cap = Number(req.body.dailyCap);
      if (!Number.isFinite(cap) || cap < 1 || cap > 200000) throw badRequest('Daily cap must be between 1 and 200,000');
      set.dailyCap = Math.round(cap);
    }
    if (req.body.stream !== undefined) set.stream = String(req.body.stream);
    if (req.body.activeHours !== undefined) set.activeHours = req.body.activeHours;
    if (!Object.keys(set).length) throw badRequest('Nothing to update — send dailyCap, stream or activeHours');
    await scoped('sending_accounts', req.ctx).updateOne({ _id: account._id }, { $set: set });
    await audit(req.ctx, 'account.update', 'sending_account', { id: account._id, ...set });
    return { ok: true, account: { ...account, ...set } };
  });

  app.delete('/accounts/:id', async req => {
    await scoped('sending_accounts', req.ctx).deleteOne({ _id: req.params.id });
    await audit(req.ctx, 'account.disconnect', 'sending_account', {});
    return { ok: true };
  });

  app.post('/accounts/selection-preview', async req => {
    const { eligibleAccounts } = await import('../../../../packages/email-engine/selection.js');
    const all = await scoped('sending_accounts', req.ctx).find({});
    const pool = eligibleAccounts(all, { stream: req.body.stream || 'outreach' });
    return { eligible: pool.length, accounts: pool.map(a => ({ id: a._id, fromEmail: a.fromEmail,
      sentToday: a.sentToday || 0, dailyCap: a.dailyCap, warmup: a.warmup })) };
  });
}
