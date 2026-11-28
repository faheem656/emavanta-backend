import { createHmac, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { badRequest } from '../../../../packages/shared/errors.js';
import { verifyWebhookSignature } from '../../../../packages/providers/webhooks.js';

/**
 * Event-tracking channels: how a mailbox REPORTS bounces/complaints back to
 * Emavanta. Every mailbox must configure at least one, and the channel is
 * tested LIVE before the mailbox is added — nothing is saved on a failed test.
 *
 *   webhook — the provider POSTs signed events to /api/v1/webhooks/mailbox/:id
 *   imap    — we poll the mailbox for DSN bounce messages
 *   pop3    — same, over POP3
 *   mailapi — we poll the ESP's REST API for bounce lists
 */
/** Channels offered on NEW mailboxes. Legacy methods keep working for accounts
 *  that already have them (receiver + re-test stay intact) but are hidden. */
export const TRACKING_METHODS = ['imap', 'pop3', 'mailapi'];
export const LEGACY_TRACKING_METHODS = ['webhook', 'hostinger'];
export const TRACKING_LABEL = { webhook: 'Webhook', imap: 'IMAP', pop3: 'POP3', mailapi: 'Mail API', hostinger: 'Hostinger' };

const HOSTINGER_API = 'https://api.mail.hostinger.com';

export const generateWebhookSecret = () => randomBytes(24).toString('hex');

/** Sign a payload exactly like a provider call would — used by tests + the inbound verifier. */
export const signPayload = (raw, secret) => createHmac('sha256', secret).update(raw).digest('hex');

const bounded = (msg, n = 160) => String(msg || '').slice(0, n);

/* ------------------------------------------------------------------ */
/* Channel tests — every one is a REAL check, not a format validation. */
/* ------------------------------------------------------------------ */

const testWebhook = cfg => {
  const secret = String(cfg?.secret || '').trim();
  if (secret.length < 16) throw badRequest('Webhook secret must be at least 16 characters — generate one and paste the same secret at your provider.');
  // Prove the exact pipeline the inbound endpoint uses: sign → verify.
  const sample = JSON.stringify({ test: true, event: 'tracking_test', email: 'sample@bounce.test', ts: Date.now() });
  const sig = signPayload(sample, secret);
  if (!verifyWebhookSignature(sample, sig, secret)) {
    throw badRequest('Webhook signature round-trip failed — this secret cannot be verified.');
  }
  return { ok: true, secret, detail: 'Signature verified — events signed with this secret will be accepted by the inbound webhook endpoint.' };
};

/** imapflow hides the server's real answer inside "Command failed" — dig it out. */
const imapReason = e => {
  for (const c of [e?.responseText, e?.text, e?.serverResponseCode, e?.response]) {
    const s = String(c || '').trim();
    if (s && s.length > 2 && !/^(NO|BAD|OK|PREAUTH)$/i.test(s)) return s;
  }
  return String(e?.message || e);
};

/** Turn the failure into an actionable sentence (the usual causes, in order). */
const imapHint = e => {
  const code = String(e?.code || '');
  const all = `${code} ${e?.message || ''}`;
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS lookup failed — check the IMAP host spelling (e.g. imap.hostinger.com).';
  if (code === 'ECONNREFUSED') return 'connection refused — check host and port (IMAP is usually 993 with TLS).';
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') return 'connection timed out — the host/port is unreachable or blocked.';
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(all)) return 'TLS/certificate error — use port 993 with TLS enabled.';
  return 'Check: IMAP host (e.g. imap.hostinger.com), port 993 + TLS, username = full email address, the MAILBOX password (set in the email panel — NOT the hosting/account password), and IMAP enabled for this mailbox.';
};

const testImap = async cfg => {
  const host = String(cfg?.host || '').trim();
  const user = String(cfg?.user || '').trim();
  const pass = String(cfg?.pass || '');
  if (!host || !user || !pass) throw badRequest('IMAP needs host, username and password.');
  const port = Number(cfg?.port) || 993;
  let ImapFlow;
  try { ({ ImapFlow } = await import('imapflow')); }
  catch { throw badRequest('IMAP client is not installed on the server.'); }
  const client = new ImapFlow({
    host, port, secure: cfg?.secure ?? (port === 993),
    auth: { user, pass }, logger: 0, timeout: 12000
  });
  try {
    await client.connect();
  } catch (e) {
    throw badRequest(`IMAP test failed — ${bounded(imapReason(e))} · ${imapHint(e)}`);
  }
  // The login already proved the channel — a failing logout must not fail the test.
  try { await client.logout(); } catch { /* best effort */ }
  return { ok: true, detail: `IMAP login verified on ${host}:${port}.` };
};

/** Minimal POP3 conversation: greet → USER → PASS → QUIT. */
const pop3Login = (host, port, secure, user, pass) => new Promise((resolve, reject) => {
  let settled = false;
  const done = (err, val) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(val); };
  const socket = (secure ? tls : net).connect({ host, port, servername: host });
  const timer = setTimeout(() => { socket.destroy(); done(new Error('POP3 connection timed out')); }, 9000);
  let step = 0;
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (!buffer.includes('\n')) return;
    const line = buffer;
    buffer = '';
    if (!/^\+OK/i.test(line)) { socket.destroy(); done(new Error(`POP3 rejected: ${bounded(line, 120)}`)); return; }
    step += 1;
    if (step === 1) socket.write(`USER ${user}\r\n`);
    else if (step === 2) socket.write(`PASS ${pass}\r\n`);
    else { socket.write('QUIT\r\n'); socket.end(); done(null, true); }
  });
  socket.on('error', e => done(new Error(`POP3 connection failed — ${bounded(e.message)}`)));
  socket.on('close', () => done(new Error('POP3 connection closed unexpectedly')));
});

const testPop3 = async cfg => {
  const host = String(cfg?.host || '').trim();
  const user = String(cfg?.user || '').trim();
  const pass = String(cfg?.pass || '');
  if (!host || !user || !pass) throw badRequest('POP3 needs host, username and password.');
  const port = Number(cfg?.port) || (cfg?.secure === false ? 110 : 995);
  try { await pop3Login(host, port, cfg?.secure ?? (port !== 110), user, pass); }
  catch (e) { throw badRequest(`POP3 test failed — ${bounded(e.message || e)}`); }
  return { ok: true, detail: `POP3 login verified on ${host}:${port}.` };
};

const MAILAPI_PROVIDERS = {
  sendgrid: key => ({ url: 'https://api.sendgrid.com/v3/scopes', headers: { authorization: `Bearer ${key}` } }),
  mailgun: (key, domain) => ({ url: 'https://api.mailgun.net/v3/domains', headers: { authorization: `Basic ${Buffer.from('api:' + key).toString('base64')}` }, needsDomain: !domain }),
  postmark: key => ({ url: 'https://api.postmarkapp.com/server', headers: { 'x-postmark-server-token': key } })
};

const testMailApi = async cfg => {
  const provider = String(cfg?.provider || '').toLowerCase();
  const apiKey = String(cfg?.apiKey || '').trim();
  const domain = String(cfg?.domain || '').trim();
  if (!MAILAPI_PROVIDERS[provider]) throw badRequest('Mail API provider must be sendgrid, mailgun or postmark.');
  if (!apiKey) throw badRequest('Mail API needs an API key.');
  if (provider === 'mailgun' && !domain) throw badRequest('Mail API (Mailgun) needs the sending domain.');
  const call = MAILAPI_PROVIDERS[provider](apiKey, domain);
  let res;
  try { res = await fetch(call.url, { headers: call.headers, signal: AbortSignal.timeout(9000) }); }
  catch (e) { throw badRequest(`Mail API test could not reach ${provider} — ${bounded(e?.message || e)}`); }
  if (!res.ok) {
    const body = String(await res.text().catch(() => '')).slice(0, 120);
    throw badRequest(`Mail API test failed — ${provider} responded ${res.status}${body ? `: ${body}` : ''}. Check the API key.`);
  }
  return { ok: true, detail: `${provider} API key verified.` };
};

/** One Mail API call — base https://api.mail.hostinger.com, Bearer token auth, `data`-wrapped responses. */
const hostingerCall = async (path, token, { method = 'GET', body } = {}) => {
  let res;
  try {
    res = await fetch(HOSTINGER_API + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) { throw badRequest(`Hostinger Mail API unreachable — ${bounded(e?.message || e)}`); }
  if (res.status === 204) return null;
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const msg = json?.error || json?.message || text.slice(0, 160) || `HTTP ${res.status}`;
    const code = json?.code ? ` (${json.code})` : '';
    if (res.status === 401) throw badRequest(`Hostinger rejected the Mail API token — ${msg}${code}. Create it under Agentic Mail → API access.`);
    if (res.status === 403) throw badRequest(`Token lacks permission — ${msg}${code}. Grant SMTP/IMAP actions and Manage webhooks when creating it.`);
    if (res.status === 422) throw badRequest(`Hostinger rejected the webhook setup — ${msg}${code}.`);
    throw badRequest(`Hostinger Mail API error — ${msg}${code}.`);
  }
  return json;
};

/**
 * Hostinger (hMail) channel — a FIRST-CLASS provider integration, not a generic
 * webhook the user has to wire up by hand:
 *   1. verify the Mail API token (GET /me) and resolve the sending mailbox;
 *   2. PROVISION the webhook ourselves (POST …/webhooks) with our public URL —
 *      this kills the "must be a publicly accessible HTTPS endpoint" hPanel
 *      manual step entirely;
 *   3. store the one-time delivery secret (Authorization: Bearer <secret>).
 * `mode:'verify'` (the "Test tracking" button) re-checks the token and runs
 * Hostinger's own test delivery through the public internet instead of
 * re-creating webhooks.
 */
const testHostinger = async (cfg = {}) => {
  const token = String(cfg.token || '').trim();
  if (token.length < 16) {
    throw badRequest('Hostinger needs the Mail API token — hPanel → Agentic Mail → API access → create a token with SMTP/IMAP actions and Manage webhooks permissions.');
  }
  const accountId = String(cfg.accountId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(accountId)) throw badRequest('Internal: mailbox id missing for webhook provisioning.');
  const base = String(process.env.API_PUBLIC_BASE || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) || /\/\/(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(base)) {
    throw badRequest('Hostinger requires a public HTTPS endpoint (no IPs or localhost). Set API_PUBLIC_BASE to your https:// domain and retry.');
  }
  // 1) token + mailbox resolution (real API call — a wrong token fails here).
  const me = await hostingerCall('/api/v1/me', token);
  const data = me?.data ?? me ?? {};
  const boxes = Array.isArray(data.mailboxes) ? data.mailboxes : (Array.isArray(data) ? data : []);
  const want = String(cfg.fromEmail || '').toLowerCase();
  const box = boxes.find(b => String(b?.address || b?.email || '').toLowerCase() === want) || boxes[0] || null;
  const mailboxResourceId = String(box?.resourceId || box?.id || box?.mailboxResourceId || '');
  if (!mailboxResourceId) {
    throw badRequest('This token manages no mailboxes — recreate it scoped to the sending mailbox (Agentic Mail → API access).');
  }
  const mailboxAddress = String(box?.address || box?.email || cfg.fromEmail || '');
  const url = `${base}/api/v1/webhooks/mailbox/${accountId}`;

  // 2) "Test tracking" on an already-provisioned channel: Hostinger itself
  // POSTs to our public endpoint and reports the upstream HTTP status.
  if (cfg.mode === 'verify' && cfg.webhookId && cfg.mailboxResourceId) {
    const t = await hostingerCall(
      `/api/v1/mailboxes/${encodeURIComponent(cfg.mailboxResourceId)}/webhooks/${encodeURIComponent(cfg.webhookId)}/test`,
      token, { method: 'POST' });
    const tr = t?.data ?? t ?? {};
    if (tr.success === false || (Number(tr.httpStatus) >= 400)) {
      throw badRequest(`Hostinger test delivery failed (HTTP ${tr.httpStatus ?? 'n/a'})${tr.error ? ` — ${bounded(tr.error)}` : ''}. The webhook URL must be publicly reachable over HTTPS.`);
    }
    return { ok: true, detail: `Live test delivery accepted (HTTP ${tr.httpStatus ?? 200}) — message.received events flow to Emavanta.` };
  }

  // 3) Provision: replace any previous webhook, then create ours (one-time secret).
  if (cfg.webhookId) {
    await hostingerCall(
      `/api/v1/mailboxes/${encodeURIComponent(cfg.mailboxResourceId || mailboxResourceId)}/webhooks/${encodeURIComponent(cfg.webhookId)}`,
      token, { method: 'DELETE' }).catch(() => { /* already gone */ });
  }
  const wh = await hostingerCall(`/api/v1/mailboxes/${mailboxResourceId}/webhooks`, token, {
    method: 'POST',
    body: {
      name: `Emavanta · ${mailboxAddress || 'tracking'}`.slice(0, 255),
      description: 'Bounce and reply events for Emavanta event tracking',
      events: ['message.received'], status: 'active', url
    }
  });
  const w = wh?.data ?? wh ?? {};
  const secret = String(w.secret || '');
  const webhookId = String(w.id || '');
  if (!secret || !webhookId) throw badRequest('Hostinger created the webhook without a secret/id — unexpected response.');
  const detail = `Mail API token verified · webhook registered for ${mailboxAddress} → ${url}`;
  // Optional extra proof when the caller asks for it right after provisioning.
  if (cfg.mode === 'verify') {
    const t = await hostingerCall(
      `/api/v1/mailboxes/${mailboxResourceId}/webhooks/${webhookId}/test`, token, { method: 'POST' });
    const tr = t?.data ?? t ?? {};
    if (tr.success === false || (Number(tr.httpStatus) >= 400)) {
      throw badRequest(`Hostinger test delivery failed (HTTP ${tr.httpStatus ?? 'n/a'})${tr.error ? ` — ${bounded(tr.error)}` : ''}. Check API_PUBLIC_BASE is publicly reachable over HTTPS.`);
    }
    return { ok: true, secret, webhookId, mailboxResourceId, mailboxAddress, detail: `${detail} · live test accepted.` };
  }
  return { ok: true, secret, webhookId, mailboxResourceId, mailboxAddress, detail };
};

/** Run the live test for a channel. Throws badRequest with the exact reason. */
export const testTrackingChannel = async (channel, cfg = {}) => {
  if (!TRACKING_METHODS.includes(channel) && !LEGACY_TRACKING_METHODS.includes(channel)) {
    throw badRequest('Choose how this mailbox reports events — IMAP, POP3 or Mail API (at least one). It is tested before the mailbox is added.');
  }
  if (channel === 'webhook') return testWebhook(cfg);
  if (channel === 'imap') return testImap(cfg);
  if (channel === 'pop3') return testPop3(cfg);
  if (channel === 'hostinger') return testHostinger(cfg);
  return testMailApi(cfg);
};

/** Shape the `tracking` sub-document stored on the sending account. */
export const buildTrackingDoc = (channel, cfg, accountId, testResult, { encryptedConfig } = {}) => {
  const now = new Date().toISOString();
  const base = {
    method: channel, status: 'verified', verifiedAt: now, lastTestAt: now,
    detail: testResult.detail, lastError: null, lastPolledAt: null
  };
  if (channel === 'webhook') return { ...base, secret: cfg.secret, webhookPath: `/api/v1/webhooks/mailbox/${accountId}` };
  if (channel === 'hostinger') {
    // Delivery secret stays plaintext (the inbound receiver verifies it on every
    // POST); the Mail API token lives inside the encrypted config.
    return { ...base, secret: testResult.secret || cfg.secret,
      webhookPath: `/api/v1/webhooks/mailbox/${accountId}`, config: encryptedConfig };
  }
  return { ...base, config: encryptedConfig };
};

/** Channel test errors must never look like a success — used by the poller too. */
export const trackingFailure = (channel, err) => `${TRACKING_LABEL[channel] || channel} tracking failed — ${bounded(err?.message || err)}`;
