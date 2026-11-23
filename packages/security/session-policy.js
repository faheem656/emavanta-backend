export const DEFAULT_SESSION_TTL_DAYS = 30;
export const MIN_SESSION_TTL_DAYS = 1;
export const MAX_SESSION_TTL_DAYS = 365;
const DAY_MS = 86_400_000;

/** Read and validate the backend's whole-day session lifetime setting. */
export function readSessionTtlDays(value = process.env.SESSION_TTL_DAYS) {
  if (value === undefined || String(value).trim() === '') return DEFAULT_SESSION_TTL_DAYS;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`SESSION_TTL_DAYS must be a whole number from ${MIN_SESSION_TTL_DAYS} to ${MAX_SESSION_TTL_DAYS}.`);
  }
  const days = Number(text);
  if (!Number.isSafeInteger(days) || days < MIN_SESSION_TTL_DAYS || days > MAX_SESSION_TTL_DAYS) {
    throw new Error(`SESSION_TTL_DAYS must be a whole number from ${MIN_SESSION_TTL_DAYS} to ${MAX_SESSION_TTL_DAYS}.`);
  }
  return days;
}

/** Expiration timestamp for new sessions and legacy persistent sessions. */
export function sessionExpiresAt(session, ttlDays = readSessionTtlDays()) {
  const explicit = Date.parse(session?.expiresAt);
  if (Number.isFinite(explicit)) return new Date(explicit).toISOString();
  if (session?.persistent === true && (session.expiresAt === null || session.expiresAt === undefined)) {
    const created = Date.parse(session.createdAt);
    if (Number.isFinite(created)) return new Date(created + ttlDays * DAY_MS).toISOString();
  }
  return null;
}

export function sessionNotExpired(session, now = Date.now(), ttlDays = readSessionTtlDays()) {
  const expiry = sessionExpiresAt(session, ttlDays);
  return !!expiry && Date.parse(expiry) > now;
}
