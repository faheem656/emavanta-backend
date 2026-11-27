import net from 'node:net';
import tls from 'node:tls';
import { collection, scoped } from '../../../../packages/database/store.js';
import { getQueue } from '../../../../packages/queue/index.js';
import { decryptCredentials } from '../../../../packages/providers/index.js';

/**
 * Polls verified tracking channels for bounce/complaint events:
 *   imap    — search the INBOX for DSN bounce messages, parse Final-Recipient
 *   pop3    — same over POP3 (UIDL-tracked so messages are read once)
 *   mailapi — pull bounce lists from SendGrid/Postmark/Mailgun REST APIs
 *
 * Every parsed bounce is enqueued into the SAME `webhook` queue the provider
 * webhooks use, so suppression, contact status, bounce-window cooldown and
 * campaign circuit-breakers behave identically no matter the channel.
 */

const DUE_MS = 5 * 60 * 1000; // poll each mailbox at most every 5 minutes

const looksLikeBounce = (subject, from) =>
  /undeliver|returned|delivery status|mail delivery failed|undeliverable|failure notice|delivery has failed|returned mail|warning:|delivery problem/i.test(subject || '')
  || /mailer-daemon|postmaster|mail delivery subsystem|mail system/i.test(from || '');

const extractBouncedEmails = text => {
  const out = new Set();
  const push = m => { const e = String(m || '').toLowerCase().trim(); if (/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e)) out.add(e); };
  for (const re of [
    /Final-Recipient:[^\r\n]*?(?:rfc822;|<)?\s*<?([^\s<>;,"']+@[^\s<>;,"']+)/gi,
    /Original-Recipient:[^\r\n]*?(?:rfc822;|<)?\s*<?([^\s<>;,"']+@[^\s<>;,"']+)/gi
  ]) { let m; while ((m = re.exec(text))) push(m[1]); }
  // Classic sendmail DSN: a permanent failure is stated in plain text. Only a
  // To: AFTER the failure marker counts — the DSN's own To: is the sender who
  // receives the report, not the address that bounced.
  const marker = text.search(/Final-Recipient|Original-Recipient|Status:\s*5\.|Action:\s*failed|Original message/i);
  if (marker >= 0) {
    let m; const toRe = /^To:\s*<?([^\s<>;,"']+@[^\s<>;,"']+)/gim;
    const tail = text.slice(marker);
    while ((m = toRe.exec(tail))) push(m[1]);
  } else if (/permanently failed|will not be attempted|mail delivery failed|undeliver|returned mail/i.test(text)) {
    // Plain-text bounce notice with no DSN headers: the first To: is the victim.
    const m = text.match(/^To:\s*<?([^\s<>;,"']+@[^\s<>;,"']+)/mi);
    if (m) push(m[1]);
  }
  return [...out];
};

const resolveRecipient = async (orgId, email) => {
  try {
    const rows = await scoped('campaign_recipients', { organizationId: orgId })
      .find({ email, status: { $in: ['sent', 'delivered', 'sending', 'deferred'] } },
        { sort: { createdAt: -1 }, limit: 1 });
    return rows[0] || null;
  } catch { return null; }
};

const enqueueBounce = async (acc, { email, reason, dedupeId, occurredAt }) => {
  if (!email) return false;
  const ctx = { organizationId: acc.organizationId };
  // Idempotent: the processor's dedupeKey is event.id, so re-polls are no-ops.
  const existing = await scoped('delivery_events', ctx).findOne({ dedupeKey: dedupeId });
  if (existing) return false;
  const recipient = await resolveRecipient(acc.organizationId, email);
  await getQueue('webhook').add('provider.event', {
    provider: acc.tracking.method,
    event: {
      id: dedupeId, type: 'bounced', email,
      organizationId: acc.organizationId,
      campaignId: recipient?.campaignId || null,
      contactId: recipient?.contactId || null,
      sendingAccountId: acc._id,
      reason: String(reason || 'mailbox reported a hard bounce').slice(0, 300),
      occurredAt: occurredAt || new Date().toISOString()
    }
  }, { jobId: dedupeId });
  // Flip the recipient row too — the campaign funnel counts it immediately.
  if (recipient?.campaignId) {
    try {
      await scoped('campaign_recipients', ctx).updateOne(
        { campaignId: recipient.campaignId, email, status: { $in: ['queued', 'sending', 'sent', 'delivered', 'deferred'] } },
        { $set: { status: 'bounced', bouncedAt: new Date().toISOString() } });
    } catch { /* the processor still records the event */ }
  }
  return true;
};

/* ------------------------------- IMAP ------------------------------- */

const pollImap = async (acc, cfg, sinceIso) => {
  let ImapFlow;
  try { ({ ImapFlow } = await import('imapflow')); } catch { throw new Error('IMAP client not installed'); }
  const client = new ImapFlow({
    host: String(cfg.host), port: Number(cfg.port) || 993,
    secure: cfg.secure ?? (Number(cfg.port) !== 110),
    auth: { user: String(cfg.user), pass: String(cfg.pass) }, logger: 0, timeout: 12000
  });
  let bounced = 0;
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Math.max(Date.parse(sinceIso || '') || 0, Date.now() - 2 * 86400000));
    const uids = await client.search({ since }, { uid: true });
    const list = (Array.isArray(uids) ? uids : []).slice(-200);
    if (!list.length) return 0;
    const candidates = [];
    for await (const m of client.fetch({ uid: list }, { envelope: true })) {
      const subj = String(m.envelope?.subject || '');
      const from = String(m.envelope?.from?.[0]?.address || m.envelope?.from?.[0]?.name || '');
      if (looksLikeBounce(subj, from)) candidates.push({ uid: m.uid, date: m.envelope?.date, subj });
    }
    for (const cand of candidates.slice(0, 12)) {
      for await (const full of client.fetch({ uid: cand.uid }, { source: true })) {
        const text = full.source?.toString('utf8') || '';
        for (const email of extractBouncedEmails(text)) {
          const done = await enqueueBounce(acc, {
            email, reason: cand.subj || 'DSN bounce message',
            dedupeId: `imap:${acc._id}:${cand.uid}:${email}`,
            occurredAt: cand.date || new Date().toISOString()
          });
          if (done) bounced += 1;
        }
      }
    }
  } finally { lock.release(); await client.logout().catch(() => {}); }
  return bounced;
};

/* ------------------------------- POP3 ------------------------------- */

/**
 * POP3 poll: USER/PASS → LIST → UIDL → RETR unseen messages.
 * `seen` (stored in tracking.state) remembers processed UIDs across polls.
 */
const pollPop3 = async (acc, cfg, seenUids) => {
  const seen = new Set(Array.isArray(seenUids) ? seenUids : []);
  const results = { retr: [], uids: [] };
  await new Promise((resolve, reject) => {
    const host = String(cfg.host);
    const port = Number(cfg.port) || (cfg.secure === false ? 110 : 995);
    const secure = cfg.secure ?? (port !== 110);
    let settled = false;
    const done = (err, val) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(val); };
    const socket = (secure ? tls : net).connect({ host, port, servername: host });
    const timer = setTimeout(() => { socket.destroy(); done(new Error('POP3 timed out')); }, 15000);
    let step = 0; // 0 greet,1 USER,2 PASS,3 LIST,4 UIDL,5+ RETR
    let buffer = '';
    let listLines = [];
    let uidlLines = [];
    let retrIdx = 0;
    let currentRetr = [];
    const send = l => socket.write(l + '\r\n');
    const multiDone = () => /\r\n\.\r?\n?$/.test(buffer);
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (step >= 3) {
        if (!multiDone()) return; // wait for the terminating dot
      } else if (!buffer.includes('\n')) return;
      const raw = buffer;
      buffer = '';
      if (!/^\+OK/i.test(raw)) { socket.destroy(); done(new Error(`POP3: ${raw.slice(0, 120)}`)); return; }
      if (step === 0) { step = 1; send(`USER ${cfg.user}`); }
      else if (step === 1) { step = 2; send(`PASS ${cfg.pass}`); }
      else if (step === 2) { step = 3; send('LIST'); }
      else if (step === 3) {
        listLines = raw.split(/\r?\n/).slice(1).filter(l => l && l !== '.');
        step = 4; send('UIDL');
      } else if (step === 4) {
        uidlLines = raw.split(/\r?\n/).slice(1).filter(l => l && l !== '.');
        const pairs = uidlLines.map((l, i) => {
          const [uid, msg] = l.split(/\s+/);
          const size = (listLines[i] || '').split(/\s+/)[1];
          return { uid, msg: msg || String(i + 1), size };
        }).filter(p => p.uid && !seen.has(p.uid));
        results.uids = pairs.map(p => p.uid);
        currentRetr = pairs.slice(-10); // cap per poll
        retrIdx = 0;
        if (!currentRetr.length) { step = 99; send('QUIT'); return; }
        step = 5; send(`RETR ${currentRetr[0].msg}`);
      } else if (step >= 5 && step < 99) {
        results.retr.push({ uid: currentRetr[retrIdx]?.uid, text: raw });
        retrIdx += 1;
        if (retrIdx < currentRetr.length) send(`RETR ${currentRetr[retrIdx].msg}`);
        else { step = 99; send('QUIT'); }
      }
    });
    socket.on('error', e => done(new Error(`POP3 connection failed — ${e.message}`)));
    socket.on('close', () => done(null, true));
  });

  let bounced = 0;
  for (const msg of results.retr) {
    if (!msg.text) continue;
    const subj = (msg.text.match(/^Subject:\s*(.*)$/mi) || [])[1] || '';
    const from = (msg.text.match(/^From:\s*(.*)$/mi) || [])[1] || '';
    if (!looksLikeBounce(subj, from)) continue;
    for (const email of extractBouncedEmails(msg.text)) {
      const done = await enqueueBounce(acc, {
        email, reason: subj || 'POP3 bounce message',
        dedupeId: `pop3:${acc._id}:${msg.uid}:${email}`
      });
      if (done) bounced += 1;
    }
  }
  return { bounced, seenUids: [...seen, ...results.uids] };
};

/* ----------------------------- Mail API ----------------------------- */

const pollMailApi = async (acc, cfg) => {
  const provider = String(cfg.provider || '').toLowerCase();
  const key = String(cfg.apiKey || '');
  const auth = provider === 'mailgun'
    ? { authorization: `Basic ${Buffer.from('api:' + key).toString('base64')}` }
    : provider === 'postmark' ? { 'x-postmark-server-token': key } : { authorization: `Bearer ${key}` };
  let list = [];
  if (provider === 'sendgrid') {
    const res = await fetch('https://api.sendgrid.com/v3/suppressions/bounces?limit=100', { headers: auth, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`SendGrid responded ${res.status}`);
    const body = await res.json();
    list = (body.bounces || []).map(b => ({ email: String(b.email || '').toLowerCase(), reason: b.reason || 'SendGrid hard bounce', at: b.created_at }));
  } else if (provider === 'postmark') {
    const res = await fetch('https://api.postmarkapp.com/bounces?count=100', { headers: auth, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Postmark responded ${res.status}`);
    const body = await res.json();
    list = (body.Bounces || []).filter(b => String(b.Type || '') === 'HardBounce')
      .map(b => ({ email: String(b.EmailAddress || '').toLowerCase(), reason: b.Description || 'Postmark hard bounce', at: b.BouncedAt }));
  } else if (provider === 'mailgun') {
    const res = await fetch(`https://api.mailgun.net/v3/${encodeURIComponent(cfg.domain)}/bounces?limit=100`, { headers: auth, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Mailgun responded ${res.status}`);
    const body = await res.json();
    list = (body.items || []).map(b => ({ email: String(b.address || '').toLowerCase(), reason: b.reason || 'Mailgun bounce', at: b.created_at }));
  } else throw new Error(`unsupported provider ${provider}`);
  let bounced = 0;
  const now = Date.now();
  for (const item of list.slice(0, 60)) {
    if (!item.email) continue;
    // Only bounces that belong to this workspace's recipients.
    const recipient = await resolveRecipient(acc.organizationId, item.email);
    if (!recipient) continue;
    const at = item.at ? new Date(item.at).toISOString() : new Date().toISOString();
    if (Date.parse(at) < now - 7 * 86400000) continue; // don't replay ancient suppressions
    const done = await enqueueBounce(acc, {
      email: item.email, reason: item.reason,
      dedupeId: `mailapi:${provider}:${acc._id}:${item.email}`, occurredAt: at
    });
    if (done) bounced += 1;
  }
  return bounced;
};

/* ----------------------------- Hostinger ---------------------------- */

const HOSTINGER_API = 'https://api.mail.hostinger.com';

const hostingerGet = async (path, token) => {
  let res;
  try {
    res = await fetch(HOSTINGER_API + path, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000)
    });
  } catch (e) { throw new Error(`Hostinger unreachable — ${e?.message || e}`); }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    throw new Error(`Hostinger ${res.status}${json?.error ? ` — ${json.error}` : text ? ` — ${text.slice(0, 120)}` : ''}`);
  }
  return json;
};

/**
 * Hostinger push channel + pull safety-net: the hMail webhook only says
 * "message.received" — the actual DSN lives in the mailbox. List the newest
 * INBOX messages, fetch the source of bounce-looking ones and run them through
 * the SAME parser the IMAP poller uses. UIDs are remembered in tracking.state
 * so nothing is processed twice.
 */
const pollHostinger = async (acc, cfg, seenUids) => {
  const token = String(cfg?.token || '');
  const mb = String(cfg?.mailboxResourceId || '');
  if (!token || !mb) throw new Error('Hostinger tracking config missing (token/mailbox resource).');
  const seen = new Set((Array.isArray(seenUids) ? seenUids : []).map(String));
  const listBody = await hostingerGet(
    `/api/v1/mailboxes/${mb}/folders/${encodeURIComponent('INBOX')}/messages?perPage=25&sort=-date`, token);
  const msgs = Array.isArray(listBody?.data) ? listBody.data : [];
  let bounced = 0, candidates = 0;
  const nextSeen = [...seen];
  const floor = Date.now() - 2 * 86400000; // don't replay ancient inbox traffic
  for (const m of msgs) {
    const uid = String(m?.uid ?? m?.id ?? '');
    if (!uid || seen.has(uid)) continue;
    nextSeen.push(uid);
    const at = m?.date ? Date.parse(m.date) : NaN;
    if (Number.isFinite(at) && at < floor) continue; // old → remembered, not processed
    if (candidates >= 12) continue;                  // cap work per poll (same as IMAP)
    const from = typeof m?.from === 'string' ? m.from : String(m?.from?.address || m?.from?.name || '');
    const subj = String(m?.subject || '');
    if (!looksLikeBounce(subj, from)) continue;
    candidates += 1;
    const srcBody = await hostingerGet(
      `/api/v1/mailboxes/${mb}/folders/${encodeURIComponent('INBOX')}/messages/${encodeURIComponent(uid)}/source`, token);
    const raw = srcBody?.data;
    const text = typeof raw === 'string' ? raw : String(raw?.source || raw?.raw || raw?.content || '');
    if (!text) continue;
    for (const email of extractBouncedEmails(text)) {
      const done = await enqueueBounce(acc, {
        email, reason: subj || 'Hostinger DSN bounce message',
        dedupeId: `hostinger:${acc._id}:${uid}:${email}`,
        occurredAt: Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString()
      });
      if (done) bounced += 1;
    }
  }
  return { bounced, seenUids: nextSeen.slice(-500) };
};

/* ------------------------------ Driver ------------------------------ */

/** Poll every due verified channel (≤5 min apart). Returns bounces found. */
export async function pollTrackingChannels({ limit = 12 } = {}) {
  const now = Date.now();
  const rows = await collection('sending_accounts').find({
    status: 'active',
    'tracking.status': 'verified',
    'tracking.method': { $in: ['imap', 'pop3', 'mailapi', 'hostinger'] }
  }, { limit: 40 });
  let processed = 0, bounced = 0;
  for (const acc of rows) {
    if (processed >= limit) break;
    const t = acc.tracking || {};
    if (t.lastPolledAt && now - Date.parse(t.lastPolledAt) < DUE_MS) continue;
    processed += 1;
    const sinceIso = t.lastPolledAt || null;
    try {
      const cfg = decryptCredentials(t.config || '');
      let found = 0;
      if (t.method === 'imap') found = await pollImap(acc, cfg, sinceIso);
      else if (t.method === 'pop3') {
        const r = await pollPop3(acc, cfg, t.state?.seenUids);
        found = r.bounced;
        await collection('sending_accounts').updateOne({ _id: acc._id },
          { $set: { 'tracking.state': { seenUids: r.seenUids.slice(-500) } } });
      } else if (t.method === 'hostinger') {
        const r = await pollHostinger(acc, cfg, t.state?.seenUids);
        found = r.bounced;
        await collection('sending_accounts').updateOne({ _id: acc._id },
          { $set: { 'tracking.state': { seenUids: r.seenUids } } });
      } else if (t.method === 'mailapi') found = await pollMailApi(acc, cfg);
      await collection('sending_accounts').updateOne({ _id: acc._id },
        { $set: { 'tracking.lastPolledAt': new Date().toISOString(), 'tracking.lastError': null } });
      bounced += found;
    } catch (e) {
      await collection('sending_accounts').updateOne({ _id: acc._id },
        { $set: { 'tracking.lastPolledAt': new Date().toISOString(), 'tracking.lastError': String(e?.message || e).slice(0, 200) } })
        .catch(() => {});
    }
  }
  return { processed, bounced };
}

export { looksLikeBounce, extractBouncedEmails };
