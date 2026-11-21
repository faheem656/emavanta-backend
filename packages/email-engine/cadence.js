import { clamp } from '../shared/utils.js';

/** Deterministic jitter so tests can verify, random enough for humans in production. */
export const jitterDelay = (policy, seed = Math.random()) => {
  const min = Number(policy.minDelaySec || 45);
  const max = Number(policy.maxDelaySec || 90);
  const pct = Number(policy.jitterPct || 20) / 100;
  const base = min + (max - min) * seed;
  const delta = base * pct * (seed - 0.5) * 2;
  return Math.round(clamp(base + delta, 5, 900) * 1000);
};

export const isWithinWindow = (policy, date = new Date()) => {
  const h = date.getUTCHours();
  const { start = 9, end = 18 } = policy.activeHours || {};
  if (h < start || h >= end) return false;
  if (!policy.weekend && (date.getUTCDay() === 0 || date.getUTCDay() === 6)) return false;
  return true;
};

export const nextSendAt = (policy, now = new Date(), seed) => {
  const delay = jitterDelay(policy, seed);
  let next = new Date(now.getTime() + delay);
  let guard = 0;
  while (!isWithinWindow(policy, next) && guard++ < 200) next = new Date(next.getTime() + 15 * 60 * 1000);
  return next;
};

export const canSend = (policy, sentToday) => Number(sentToday || 0) < Number(policy.dailyCap || 50);

/**
 * The sending policy a campaign actually runs with.
 *
 * 'blast' sends back to back (a one-second gap, no working-hours window) and lets the
 * provider rate limiter be the only brake. 'human' keeps the configured pause between
 * emails, stays inside working hours and skips weekends — the difference matters when a
 * campaign goes to strangers rather than to people who asked for it.
 */
export const pacingFor = (campaign = {}) => {
  const base = campaign.sendPolicy || {};
  if (campaign.sendMode === 'blast') {
    return { ...base, sendMode: 'blast', minDelaySec: 1, maxDelaySec: 2, jitterPct: 0,
      activeHours: { start: 0, end: 24 }, weekend: true, timezone: base.timezone || 'UTC',
      dailyCap: Number(base.dailyCap) || 5000, weeklyCap: Number(base.weeklyCap) || 35000,
      pauseOnReply: false };
  }
  // Human-paced defaults: working hours, no weekends, one at a time.
  const human = { sendMode: 'human', activeHours: { start: 9, end: 18 }, weekend: false, ...base };
  const gap = Number(campaign.gapSeconds || 0);
  if (gap > 0) {
    // one number from the user becomes a natural range around it
    return { ...human, minDelaySec: Math.max(5, Math.round(gap * 0.8)),
      maxDelaySec: Math.max(8, Math.round(gap * 1.2)), jitterPct: 20 };
  }
  return human;
};

/** Plain-language estimate the campaign wizard can show before anything is sent. */
export const estimate = ({ recipients = 0, mode = 'human', gapSeconds = 45, dailyCap = 50, perBatch = 40 } = {}) => {
  if (mode === 'blast') {
    const perMinute = perBatch;
    return { perHour: perMinute * 60, perDay: null,
      text: `sends in batches of ${perBatch} — a few hundred emails per minute, limited only by your mailboxes` };
  }
  const gap = Math.max(5, Number(gapSeconds) || 45);
  const perHour = Math.max(1, Math.round(3600 / gap));
  const perDay = Math.min(perHour * 24, Number(dailyCap) || 50);
  const hours = recipients ? Math.max(1, Math.ceil(recipients / perHour)) : 0;
  const days = recipients ? Math.max(1, Math.ceil(recipients / perDay)) : 0;
  return { perHour, perDay, hours, days,
    text: `about ${perHour} emails per hour (${perDay} per day with your cap)` };
};
