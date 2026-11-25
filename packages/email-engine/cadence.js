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

const weekdayToIso = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7
};

const localParts = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'UTC',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    day: weekdayToIso[values.weekday],
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute)
  };
};

const timeToMinutes = value => {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
};

export const isWithinWindow = (policy = {}, date = new Date()) => {
  const schedule = policy.schedule;

  // Explicit campaign schedule: evaluate local wall-clock time in its IANA timezone.
  if (schedule) {
    const local = localParts(date, policy.timezone || 'UTC');
    const days = schedule.daysOfWeek || [];
    const start = timeToMinutes(schedule.startTime);
    const end = timeToMinutes(schedule.endTime);
    return days.includes(local.day) && local.minuteOfDay >= start && local.minuteOfDay < end;
  }

  // Legacy campaigns retain their previous UTC active-hours behavior.
  const h = date.getUTCHours();
  const { start = 9, end = 18 } = policy.activeHours || {};
  if (h < start || h >= end) return false;
  if (!policy.weekend && (date.getUTCDay() === 0 || date.getUTCDay() === 6)) return false;
  return true;
};

export const nextSendAt = (policy, now = new Date(), seed) => {
  const delay = jitterDelay(policy, seed);
  let next = new Date(now.getTime() + delay);

  if (policy.schedule) {
    // Scan real instants, not wall-clock offsets. Intl applies DST transitions correctly.
    // The scan is bounded to eight days so malformed policies cannot loop forever.
    const limit = 8 * 24 * 60;
    for (let i = 0; i <= limit; i++) {
      if (isWithinWindow(policy, next)) return next;
      next = new Date(Math.floor(next.getTime() / 60000) * 60000 + 60000);
    }
    return next;
  }

  // Preserve the legacy 15-minute UTC scheduling behavior for old campaigns.
  let guard = 0;
  while (!isWithinWindow(policy, next) && guard++ < 200) {
    next = new Date(next.getTime() + 15 * 60 * 1000);
  }
  return next;
};

export const canSend = (policy, sentToday) =>
  Number(sentToday || 0) < Number(policy.dailyCap || 50);

/**
 * Campaign pacing policy.
 * Explicit schedules apply to both human and blast modes.
 * Old campaigns without a schedule retain their previous mode behavior.
 */
export const pacingFor = (campaign = {}) => {
  const base = campaign.sendPolicy || {};
  const hasSchedule = !!base.schedule;

  if (campaign.sendMode === 'blast') {
    return {
      ...base,
      sendMode: 'blast',
      minDelaySec: 1,
      maxDelaySec: 2,
      jitterPct: 0,
      ...(hasSchedule ? {} : { activeHours: { start: 0, end: 24 }, weekend: true }),
      timezone: base.timezone || 'UTC',
      dailyCap: Number(base.dailyCap) || 5000,
      weeklyCap: Number(base.weeklyCap) || 35000,
      pauseOnReply: false
    };
  }

  const human = {
    sendMode: 'human',
    activeHours: { start: 9, end: 18 },
    weekend: false,
    ...base
  };
  const gap = Number(campaign.gapSeconds || 0);

  if (gap > 0) {
    return {
      ...human,
      minDelaySec: Math.max(5, Math.round(gap * 0.8)),
      maxDelaySec: Math.max(8, Math.round(gap * 1.2)),
      jitterPct: 20
    };
  }
  return human;
};

/** Plain-language estimate the campaign wizard can show before anything is sent. */
export const estimate = ({
  recipients = 0, mode = 'human', gapSeconds = 45, dailyCap = 50, perBatch = 40
} = {}) => {
  if (mode === 'blast') {
    const perMinute = perBatch;
    return {
      perHour: perMinute * 60,
      perDay: null,
      text: `sends in batches of ${perBatch} — a few hundred emails per minute, limited only by your mailboxes`
    };
  }
  const gap = Math.max(5, Number(gapSeconds) || 45);
  const perHour = Math.max(1, Math.round(3600 / gap));
  const perDay = Math.min(perHour * 24, Number(dailyCap) || 50);
  const hours = recipients ? Math.max(1, Math.ceil(recipients / perHour)) : 0;
  const days = recipients ? Math.max(1, Math.ceil(recipients / perDay)) : 0;
  return {
    perHour, perDay, hours, days,
    text: `about ${perHour} emails per hour (${perDay} per day with your cap)`
  };
};
