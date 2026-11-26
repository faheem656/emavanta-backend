/**
 * Deliverability support tools for user-owned sending infrastructure.
 * We are NOT an ESP: the customer owns domains, mailboxes, IPs and reputation.
 * This module only advises, classifies provider events and enforces hygiene.
 */
import { resolveTxt, resolveCname } from 'node:dns/promises';
import { STREAMS } from '../shared/constants.js';

export const MAIL_STREAMS = Object.freeze({
  transactional: { priority: 'critical', batchSize: 25, separateAccount: true, humanCadence: false },
  marketing: { priority: 'bulk', batchSize: 250, separateAccount: true, humanCadence: false },
  outreach: { priority: 'outreach', batchSize: 100, separateAccount: true, humanCadence: true }
});

export const streamConfig = stream => MAIL_STREAMS[stream] || MAIL_STREAMS.marketing;

/**
 * How fast a workspace is allowed to push, by plan. This is a *ceiling*, not a promise:
 * the mailbox caps, the human cadence and the provider limits still apply on top.
 * It exists so a large plan is not silently held at 3 600/hour by a fixed constant.
 */
export const PLAN_THROUGHPUT_PER_HOUR = Object.freeze({
  free: 200, trial: 500, launch: 2000, growth: 5000, scale: 25000, business: 100000
});

export const throughputFor = (plan = 'growth') => {
  const perHour = PLAN_THROUGHPUT_PER_HOUR[plan] ?? PLAN_THROUGHPUT_PER_HOUR.growth;
  return { perHour, burst: Math.max(60, Math.round(perHour / 30)),
    refillPerSec: Math.max(0.5, Math.round((perHour / 3600) * 100) / 100) };
};

/**
 * Provider cooling-off windows come back in the error text itself:
 * "…will not be allowed to send emails till [time=2026-11-25 23:36:48 UTC]".
 * Honour the provider's own clock when it gives one; otherwise back off an hour.
 * Used to set `limitedUntil` so a limited mailbox resumes BY ITSELF.
 */
export const cooldownUntil = (message = '', from = Date.now()) => {
  const m = String(message).match(/\[time=(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s*UTC\]/i);
  if (m) {
    const t = Date.parse(`${m[1].replace(' ', 'T')}Z`);
    if (Number.isFinite(t) && t > from) return new Date(t).toISOString();
  }
  return new Date(from + 3600_000).toISOString();
};

/** Providers typically hard-block a mailbox at 5 bounces/hour — mirror that proactively. */
export const BOUNCE_AUTO_LIMIT = 5;

/**
 * Campaign circuit breaker: once a campaign has sent enough to be meaningful
 * (≥ minSent) its bounce rate crossing `rate` pauses the WHOLE campaign for
 * review — the industry-standard protection for a sender's reputation.
 */
export const BOUNCE_PAUSE = Object.freeze({ rate: 0.05, minSent: 20 });

/**
 * Classify a send failure so the system reacts correctly instead of guessing:
 *  - 'auth'     → the mailbox cannot log in (535/credentials): NOTHING was sent,
 *                  keep the recipient queued and demand a reconnect;
 *  - 'account'  → the provider is holding the whole mailbox (hourly limits, 4xx
 *                  throttling): nothing was sent, cool the mailbox down;
 *  - 'rejected' → the RECIPIENT refused the mail (550-class): a definite bounce —
 *                  mark it, suppress the address, count it;
 *  - 'unknown'  → ambiguous (timeout mid-send): the outcome needs manual review.
 */
export const classifySendError = (err = {}) => {
  const msg = String(err.message || err || '');
  if (err.code === 'REAUTH_REQUIRED') return 'auth';
  if (/\b5\.4\.6\b|hourly bounce limit|rate.?limit|too many|try again later|\b42[12]\b|\b45[0-2]\b|\b4\.7\./i.test(msg)) return 'account';
  if (/53[045]\b[^\n]*auth|authentication failed|invalid login|login denied|credentials (rejected|invalid)|auth(entication)?\s*(failed|error)/i.test(msg)) return 'auth';
  if (/\b55[0-3]\b|\b5\.1\.[1-6]\b|\b5\.5\.[12]\b|recipient rejected|address rejected|user unknown|user (does not exist|unknown)|does not exist|mailbox unavailable|no such recipient|over quota|mailbox full/i.test(msg)) return 'rejected';
  return 'unknown';
};

/**
 * Rolling one-hour bounce ledger per mailbox (mirrors the provider's hourly
 * bounce limit). Returns the new window plus whether the auto-pause fired.
 */
export const bumpBounceWindow = (account, now = Date.now()) => {
  const win = account?.bounceWindow || {};
  const within = win.start && (now - Date.parse(win.start)) < 3600_000;
  const start = within ? win.start : new Date(now).toISOString();
  const count = (within ? win.count || 0 : 0) + 1;
  return { start, count, limitHit: count >= BOUNCE_AUTO_LIMIT,
    until: new Date(Date.parse(start) + 3600_000).toISOString() };
};

/** Normalise provider bounce/complaint payloads into one internal taxonomy. */
export const classifyEvent = payload => {
  const raw = String([payload?.type, payload?.event, payload?.bounceType, payload?.bounceSubType, payload?.reason].filter(Boolean).join(' ')).toLowerCase();
  const sub = raw;
  if (/complaint|spamreport|abuse/.test(raw + ' ' + sub)) return { type: 'complained', severity: 'critical', action: 'suppress_and_pause' };
  if (/hard|permanent|blocked|invalidrecipient/.test(raw + ' ' + sub)) return { type: 'bounced', severity: 'high', action: 'suppress' };
  if (/soft|temporary|mailboxfull|deferred|tryagain/.test(raw + ' ' + sub)) return { type: 'deferred', severity: 'low', action: 'retry_later' };
  if (/delivered|accepted/.test(raw)) return { type: 'delivered', severity: 'none', action: 'record' };
  if (/open/.test(raw)) return { type: 'opened', severity: 'none', action: 'record' };
  if (/click/.test(raw)) return { type: 'clicked', severity: 'none', action: 'record' };
  if (/reply/.test(raw)) return { type: 'replied', severity: 'none', action: 'pause_sequence' };
  return { type: 'unknown', severity: 'none', action: 'record' };
};

export const dnsAdvice = domain => ({
  domain,
  records: [
    { type: 'TXT', name: domain, value: 'v=spf1 include:_spf.yourprovider.example ~all', purpose: 'SPF authorises your own sending provider' },
    { type: 'TXT', name: `selector1._domainkey.${domain}`, value: 'v=DKIM1; k=rsa; p=<your-public-key>', purpose: 'DKIM signing at your provider' },
    { type: 'TXT', name: `_dmarc.${domain}`, value: 'v=DMARC1; p=none; rua=mailto:dmarc@' + domain, purpose: 'DMARC aggregate reports' },
    { type: 'CNAME', name: `track.${domain}`, value: 'cname.your-emavanta-domain.example', purpose: 'Branded tracking domain' }
  ],
  note: 'Advisor only. You publish these records with your registrar; we verify propagation and never claim delivery guarantees.'
});

/** Best-effort live verification; network failures never break the API. */
export const verifyDns = async domain => {
  const advice = dnsAdvice(domain);
  const checks = [];
  for (const record of advice.records.filter(r => r.type === 'TXT')) {
    try {
      const txts = await resolveTxt(record.name === domain ? domain : `_dmarc.${domain}`);
      const values = txts.map(parts => parts.join(''));
      checks.push({ name: record.name, verified: values.some(v => v.startsWith(record.value.split(' ')[0])), found: values });
    } catch { checks.push({ name: record.name, verified: false, found: [] }); }
  }
  try {
    const cname = await resolveCname(`track.${domain}`);
    checks.push({ name: `track.${domain}`, verified: cname.length > 0, found: cname });
  } catch { checks.push({ name: `track.${domain}`, verified: false, found: [] }); }
  return { ...advice, checks, verified: checks.every(c => c.verified) };
};

export const reputationScore = ({ bounceRate = 0, complaintRate = 0, deferredRate = 0, warmup = false, status = 'active' }) => {
  const penalty = bounceRate * 220 + complaintRate * 1400 + deferredRate * 60 + (warmup ? 5 : 0) + (status !== 'active' ? 25 : 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  return { score, band: score >= 85 ? 'healthy' : score >= 65 ? 'watch' : score >= 40 ? 'risk' : 'critical' };
};

export const warmupPlan = (start = 10, days = 14, multiplier = 1.8) => {
  const plan = [];
  let volume = start;
  for (let day = 1; day <= days; day++) {
    plan.push({ day, volume: Math.round(volume), active: true });
    volume = Math.min(volume * multiplier, 500);
  }
  return plan;
};

export const rampCapForDay = (plan, day) => plan?.[Math.max(0, Math.min((plan.length || 1) - 1, day - 1))]?.volume || 50;

/** Suppression is checked at enqueue AND immediately before send. */
export const suppressionDecision = ({ email, entries = [], stream = 'marketing' }) => {
  const hit = entries.find(e => String(e.email).toLowerCase() === String(email).toLowerCase() && e.status !== 'expired');
  if (!hit) return { suppressed: false };
  if (['unsubscribed', 'complaint', 'hard_bounce', 'manual'].includes(hit.reason) || stream === 'marketing') return { suppressed: true, reason: hit.reason };
  return { suppressed: false, note: 'transactional exception may apply; controller decides legality' };
};

export const seedPlacementScore = results => {
  const list = Array.isArray(results) ? results : [];
  const inbox = list.filter(r => r.placement === 'inbox').length;
  return { tested: list.length, inbox, rate: list.length ? +(inbox / list.length).toFixed(3) : 0,
    grade: list.length && inbox / list.length >= 0.9 ? 'A' : list.length && inbox / list.length >= 0.75 ? 'B' : 'C' };
};
