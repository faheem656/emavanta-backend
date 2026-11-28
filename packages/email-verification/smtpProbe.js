import net from 'node:net';
import tls from 'node:tls';

/**
 * SMTP probes — the layer that turns "the domain exists" into high-confidence
 * mailbox truth (this is what paid verifiers charge for):
 *
 *   1. CATCH-ALL probe (per-domain, cached): RCPT TO:<random>@domain
 *        250 = the domain accepts ANY local part → CATCH_ALL (never proof)
 *        5xx = it actively rejects unknown mailboxes → strict domain
 *   2. ADDRESS probe (per-address): RCPT TO:<actual address>
 *        250 = the mailbox exists            → VALID, confidence high
 *        5xx = the mailbox does not exist    → INVALID (mailbox_not_found)
 *        4xx / timeout / greylist           → inconclusive (fail-soft, never
 *                                             INVALID, never a charge refund)
 *
 * Fail-soft by design: port 25 is blocked on many hosts — when a probe cannot
 * run, the classifier keeps its domain-level verdict (no UNKNOWN spam).
 * NEVER used to enumerate real addresses: the catch-all probe uses random
 * garbage local parts; the address probe only asks about the address the user
 * already gave us.
 */
export const PROBE_TIMEOUT_MS = 5000;

let transport = null; // tests inject a fake conversation
export const __setSmtpTransport = fn => { transport = fn; };

const randomLocal = () => `probe-${Math.random().toString(36).slice(2, 10)}`;

/** Minimal SMTP state machine: greet → EHLO → MAIL → RCPT → QUIT.
 *  Resolves {ok, hard, code, reason} once the RCPT reply arrives (or fails). */
const rcptOnce = (mxHost, rcpt) => new Promise(resolve => {
  let settled = false;
  let buffer = '';
  let step = 0;
  const done = result => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { socket.destroy(); } catch { /* already closed */ }
    try { socket.write('QUIT\r\n'); } catch { /* best effort */ }
    resolve(result);
  };
  const socket = net.connect({ host: mxHost, port: 25, servername: mxHost });
  const timer = setTimeout(() => done({ ok: false, hard: false, reason: 'timeout' }), PROBE_TIMEOUT_MS);
  const send = line => socket.write(`${line}\r\n`);

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (!/\r\n$/.test(buffer)) return;
    const lines = buffer.split('\r\n').filter(Boolean);
    buffer = '';
    const last = lines[lines.length - 1] || '';
    const code = Number(last.slice(0, 3));
    const cont = last[3] === '-'; // multiline reply, keep reading
    if (cont) return;
    if (step === 0) {
      if (code !== 220) return done({ ok: false, hard: false, reason: `greeting ${code}` });
      step = 1; send('EHLO emavanta.invalid');
    } else if (step === 1) {
      if (code !== 250) return done({ ok: false, hard: false, reason: `ehlo ${code}` });
      step = 2; send('MAIL FROM:<probe@emavanta.invalid>');
    } else if (step === 2) {
      if (code !== 250) return done({ ok: false, hard: false, reason: `mail ${code}` });
      step = 3; send(`RCPT TO:<${rcpt}>`);
    } else if (step === 3) {
      if (code === 250 || code === 251) return done({ ok: true, hard: false, code });
      if (code >= 500) return done({ ok: false, hard: true, code });
      if (code >= 400) return done({ ok: false, hard: false, code });
      return done({ ok: false, hard: false, code, reason: `rcpt ${code}` });
    }
  });
  socket.on('error', e => done({ ok: false, hard: false, reason: String(e?.code || e?.message || 'socket') }));
  socket.on('close', () => done({ ok: false, hard: false, reason: 'closed' }));
  void tls; // reserved for implicit-TLS MXs if ever needed
});

const viaTransport = async (domain, mxHost, address, valid) => {
  const r = await transport(domain, mxHost, address);
  return valid.includes(r) ? r : 'inconclusive';
};

/** Per-domain catch-all probe — ONE conversation per domain (cached). */
export const probeCatchAll = async (domain, mxHost) => {
  const d = String(domain || '').toLowerCase();
  const mx = String(mxHost || '').toLowerCase();
  if (!d || !mx) return 'inconclusive';
  try {
    if (transport) return viaTransport(d, mx, undefined, ['catch_all', 'rejects_unknown', 'inconclusive']);
    const r = await rcptOnce(mx, randomLocal().replace('@emavanta.invalid', `@${d}`));
    if (r.ok) return 'catch_all';
    if (r.hard) return 'rejects_unknown';
    return 'inconclusive';
  } catch {
    return 'inconclusive';
  }
};

/**
 * Per-address SMTP probe — asks the mail server about the ACTUAL address.
 * This is the accuracy layer: strict domains give a definitive mailbox verdict.
 * @returns {Promise<'exists'|'rejects'|'tempfail'|'inconclusive'>}
 */
export const probeAddress = async (domain, mxHost, address) => {
  const d = String(domain || '').toLowerCase();
  const mx = String(mxHost || '').toLowerCase();
  const a = String(address || '').trim().toLowerCase();
  if (!d || !mx || !a || !a.includes('@')) return 'inconclusive';
  try {
    if (transport) return viaTransport(d, mx, a, ['exists', 'rejects', 'tempfail', 'inconclusive']);
    const r = await rcptOnce(mx, a);
    if (r.ok) return 'exists';
    if (r.hard) return 'rejects';
    return 'tempfail'; // 4xx greylisting / tarpit / timeout → no verdict change
  } catch {
    return 'inconclusive';
  }
};
