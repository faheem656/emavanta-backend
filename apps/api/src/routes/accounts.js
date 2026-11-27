import { scoped, collection } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS, canAccessWorkspace } from '../../../../packages/security/rbac.js';
import { createOAuthState, googleAuthUrl, microsoftAuthUrl, exchangeCode } from '../../../../packages/security/oauth.js';
import { encryptCredentials, decryptCredentials } from '../../../../packages/providers/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { badRequest, notFound, forbidden, tooMany } from '../../../../packages/shared/errors.js';
import { acquireStream } from '../../../../packages/rate-limiter/index.js';
import { cooldownUntil, classifySendError } from '../../../../packages/deliverability/index.js';
import { config } from '../config.js';
import { audit } from '../plugins/audit.js';
import { TRACKING_METHODS, TRACKING_LABEL, testTrackingChannel, generateWebhookSecret, signPayload, buildTrackingDoc } from '../services/trackingChannels.js';

const oauthStates = new Map();
const HOSTINGER_API_BASE = 'https://api.mail.hostinger.com';

export default async function accountRoutes(app) {
  app.get('/accounts', async req => {
    const all = await scoped('sending_accounts', req.ctx).find({});
    return all.filter(a => canAccessWorkspace(req.ctx, a.workspaceId))
      .map(a => {
        const t = a.tracking && a.tracking.method ? {
          method: a.tracking.method, status: a.tracking.status || null,
          verifiedAt: a.tracking.verifiedAt || null, lastTestAt: a.tracking.lastTestAt || null,
          lastPolledAt: a.tracking.lastPolledAt || null, lastError: a.tracking.lastError || null,
          detail: a.tracking.detail || null,
          ...(a.tracking.method === 'webhook' || a.tracking.method === 'hostinger'
            ? { webhookPath: a.tracking.webhookPath || null, secret: a.tracking.secret || null }
            : {})
        } : null;
        const { encryptedCredentials, credentials, tracking, ...rest } = a;
        return { ...rest, tracking: t, encryptedCredentials: '[ENCRYPTED]', credentials: undefined };
      });
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
    // Event tracking is MANDATORY: every mailbox reports bounces/complaints
    // through at least one channel, and the channel is tested LIVE here —
    // if the test fails, the account is NOT added.
    const trackingMethod = String(req.body?.tracking?.method || '').toLowerCase();
    if (!TRACKING_METHODS.includes(trackingMethod)) {
      throw badRequest('Choose how this mailbox reports bounces — Webhook, IMAP, POP3, Mail API or Hostinger (at least one). It is tested before the mailbox is added.');
    }
    const accountId = newId();
    const trackingCfg = { ...(req.body?.tracking || {}) };
    delete trackingCfg.method;
    trackingCfg.accountId = accountId;          // Hostinger provisions the webhook against THIS id
    trackingCfg.fromEmail = fromEmail;
    if (trackingMethod === 'webhook' && !trackingCfg.secret) trackingCfg.secret = generateWebhookSecret();
    const trackingTest = await testTrackingChannel(trackingMethod, trackingCfg);
    if (trackingMethod === 'hostinger') {
      // Keep the provisioning results (webhook id + mailbox resource) in the
      // encrypted config so re-test / reconfigure can manage the webhook later.
      Object.assign(trackingCfg, { webhookId: trackingTest.webhookId,
        mailboxResourceId: trackingTest.mailboxResourceId, mailboxAddress: trackingTest.mailboxAddress });
    }
    const status = method === 'mock' ? 'active' : (method === 'esp_api' || c.skipTest === true ? 'pending_verification' : 'active');
    const account = await scoped('sending_accounts', req.ctx).create({ _id: accountId, authMethod: method, status,
      stream: req.body.stream || 'outreach', fromEmail, fromName: req.body.fromName || '',
      smtpHost: method === 'smtp' ? c.host : undefined,
      shared: !!req.body.shared, workspaceId: req.body.workspaceId || null, dailyCap: req.body.dailyCap || 50,
      warmup: !!req.body.warmup, sentToday: 0, connectedAt: new Date().toISOString(),
      tracking: buildTrackingDoc(trackingMethod, trackingCfg, accountId, trackingTest,
        { encryptedConfig: trackingMethod === 'webhook' ? undefined : encryptCredentials(trackingCfg) }),
      encryptedCredentials: encryptCredentials({ ...c, skipTest: undefined }) });
    await audit(req.ctx, 'account.connect', 'sending_account', { method, verified: status === 'active', tracking: trackingMethod });
    return { ...account, encryptedCredentials: '[ENCRYPTED]', verified: status === 'active',
      tracking: { method: trackingMethod, status: 'verified', webhookPath: account.tracking.webhookPath || null, secret: account.tracking.secret || null },
      next: status === 'active'
        ? `Mailbox connected · ${TRACKING_LABEL[trackingMethod]} tracking verified. Send a test email to confirm delivery.`
        : `Mailbox saved · ${TRACKING_LABEL[trackingMethod]} tracking verified. Run a connection test to activate sending.` };
  });

  // Live re-test of the stored channel — "Test tracking" on the accounts page.
  // Webhook does a REAL signed ping through the public inbound endpoint.
  app.post('/accounts/:id/tracking/test', async req => {
    assertPermission(req.ctx, PERMISSIONS.ACCOUNTS_CONNECT);
    const acc = await scoped('sending_accounts', req.ctx).findOne({ _id: req.params.id });
    if (!acc || !canAccessWorkspace(req.ctx, acc.workspaceId)) throw notFound('Account not found');
    const t = acc.tracking || {};
    if (!t.method) throw badRequest('No event tracking configured for this mailbox.');
    const now = new Date().toISOString();
    if (t.method === 'webhook') {
      const sample = JSON.stringify({ test: true, event: 'tracking_test', email: acc.fromEmail, accountId: acc._id, ts: Date.now() });
      const sig = signPayload(sample, t.secret || '');
      const base = process.env.API_PUBLIC_BASE || `http://127.0.0.1:${config.port}`;
      let res;
      try {
        res = await fetch(`${base}/api/v1/webhooks/mailbox/${acc._id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-webhook-signature': sig },
          body: sample, signal: AbortSignal.timeout(8000)
        });
      } catch (e) { throw badRequest(`Webhook endpoint unreachable — ${e.message}`); }
      if (!res.ok) throw badRequest(`Webhook endpoint rejected the signed test event (HTTP ${res.status}).`);
      await scoped('sending_accounts', req.ctx).updateOne({ _id: acc._id },
        { $set: { 'tracking.lastTestAt': now, 'tracking.lastError': null, 'tracking.detail': 'Live ping accepted — endpoint reachable and signature verified.' } });
      return { ok: true, message: 'Live webhook test accepted — the endpoint is reachable and the signature verified.' };
    }
    const cfg = decryptCredentials(t.config || '');
    // Hostinger's re-test is a REAL delivery through the public internet:
    // Hostinger POSTs to our webhook URL and reports the upstream status.
    const r = await testTrackingChannel(t.method, t.method === 'hostinger'
      ? { ...cfg, mode: 'verify', accountId: acc._id, fromEmail: acc.fromEmail }
      : cfg);
    await scoped('sending_accounts', req.ctx).updateOne({ _id: acc._id },
      { $set: { 'tracking.lastTestAt': now, 'tracking.lastError': null, 'tracking.detail': r.detail } });
    return { ok: true, message: r.detail };
  });

  // Reconfigure the channel — same test-first rule: nothing saves unless it passes.
  app.post('/accounts/:id/tracking', async req => {
    assertPermission(req.ctx, PERMISSIONS.ACCOUNTS_CONNECT);
    const acc = await scoped('sending_accounts', req.ctx).findOne({ _id: req.params.id });
    if (!acc || !canAccessWorkspace(req.ctx, acc.workspaceId)) throw notFound('Account not found');
    const method = String(req.body?.tracking?.method || '').toLowerCase();
    if (!TRACKING_METHODS.includes(method)) throw badRequest('Unknown tracking channel.');
    const cfg = { ...(req.body?.tracking || {}) };
    delete cfg.method;
    cfg.accountId = acc._id;
    cfg.fromEmail = acc.fromEmail;
    if (method === 'webhook' && !cfg.secret) cfg.secret = generateWebhookSecret();
    if (method === 'hostinger') {
      // Replace (not duplicate) the previously provisioned webhook on reconfigure.
      try {
        const old = decryptCredentials(acc.tracking?.config || '');
        if (old?.webhookId) { cfg.webhookId = old.webhookId; cfg.mailboxResourceId = old.mailboxResourceId; }
      } catch { /* fresh provision */ }
    } else if (acc.tracking?.method === 'hostinger') {
      // Switching AWAY from Hostinger: remove the webhook we provisioned so it
      // stops POSTing at us (best effort — the token may already be revoked).
      try {
        const old = decryptCredentials(acc.tracking.config || '');
        if (old?.webhookId && old?.token) {
          await fetch(`${HOSTINGER_API_BASE}/api/v1/mailboxes/${encodeURIComponent(old.mailboxResourceId)}/webhooks/${encodeURIComponent(old.webhookId)}`,
            { method: 'DELETE', headers: { authorization: `Bearer ${old.token}` }, signal: AbortSignal.timeout(8000) }).catch(() => {});
        }
      } catch { /* nothing to clean */ }
    }
    const r = await testTrackingChannel(method, cfg);
    if (method === 'hostinger') {
      Object.assign(cfg, { webhookId: r.webhookId, mailboxResourceId: r.mailboxResourceId, mailboxAddress: r.mailboxAddress });
    }
    const now = new Date().toISOString();
    const set = {
      'tracking.method': method, 'tracking.status': 'verified', 'tracking.verifiedAt': now,
      'tracking.lastTestAt': now, 'tracking.lastError': null, 'tracking.detail': r.detail,
      'tracking.lastPolledAt': null
    };
    const unset = {};
    if (method === 'webhook') { set['tracking.secret'] = cfg.secret; set['tracking.webhookPath'] = `/api/v1/webhooks/mailbox/${acc._id}`; unset['tracking.config'] = ''; }
    else if (method === 'hostinger') { set['tracking.secret'] = r.secret; set['tracking.webhookPath'] = `/api/v1/webhooks/mailbox/${acc._id}`; set['tracking.config'] = encryptCredentials(cfg); }
    else { set['tracking.config'] = encryptCredentials(cfg); unset['tracking.secret'] = ''; unset['tracking.webhookPath'] = ''; }
    await scoped('sending_accounts', req.ctx).updateOne({ _id: acc._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    await audit(req.ctx, 'account.tracking_update', 'sending_account', { method });
    return { ok: true, message: `${TRACKING_LABEL[method]} tracking verified and saved.`, detail: r.detail };
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
      // 535-style login failures demand a reconnect (nothing was sent); anything
      // else cools the mailbox down with a deadline it recovers from by itself.
      const auth = e.code === 'REAUTH_REQUIRED' || classifySendError(e) === 'auth';
      await scoped('sending_accounts', req.ctx).updateOne({ _id: acc._id }, { $set: {
        status: auth ? 'reauth_required' : 'limited',
        ...(auth ? {} : { limitedUntil: cooldownUntil(e.message) }),
        lastError: e.message
      } });
      throw badRequest(`Verification email could not be sent: ${e.message}`);
    }
  });

  /**
   * Reconnect an SMTP mailbox after an auth failure (535): the user pastes the
   * new password, we probe the server for real, and the mailbox goes straight
   * back to `active` — campaigns resume by themselves on the next tick.
   */
  app.post('/accounts/:id/reconnect', async req => {
    assertPermission(req.ctx, PERMISSIONS.ACCOUNTS_CONNECT);
    const acc = await scoped('sending_accounts', req.ctx).findOne({ _id: req.params.id });
    if (!acc || !canAccessWorkspace(req.ctx, acc.workspaceId)) throw notFound('Account not found');
    if (acc.authMethod !== 'smtp') throw badRequest('Reconnect this mailbox with its provider (OAuth).');
    const pass = String(req.body?.pass || '');
    if (!pass) throw badRequest('Enter the mailbox password or app password.');
    const creds = decryptCredentials(acc.encryptedCredentials) || {};
    const next = { ...creds, pass };
    const { testSmtp } = await import('../../../../packages/providers/smtp.js');
    try {
      await testSmtp({ credentials: { host: next.host, port: next.port || 587,
        secure: !!next.secure, user: next.user, pass: next.pass } });
    } catch (e) { throw badRequest(`Mail server rejected the credentials: ${e.message}`); }
    await scoped('sending_accounts', req.ctx).updateOne({ _id: acc._id }, { $set: {
      encryptedCredentials: encryptCredentials(next), status: 'active',
      lastError: null, limitedUntil: null
    } });
    await audit(req.ctx, 'account.reconnect', 'sending_account', { id: acc._id });
    return { ok: true, message: `${acc.fromEmail} is back online — sending resumes automatically.` };
  });

  /**
   * Edit the limits of a connected mailbox (send policy page). Only the fields the
   * user can reason about are accepted — credentials are never editable here.
   */
  app.delete('/accounts/:id', async req => {
    await scoped('sending_accounts', req.ctx).deleteOne({ _id: req.params.id });
    await audit(req.ctx, 'account.disconnect', 'sending_account', {});
    return { ok: true };
  });

}
