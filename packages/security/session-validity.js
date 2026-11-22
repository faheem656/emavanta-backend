// Explicit persistent marker prevents malformed or legacy missing expiries from becoming immortal.
export function sessionNotExpired(session, now = Date.now()) {
  if (session?.persistent === true && session.expiresAt === null) return true;
  const expires = Date.parse(session?.expiresAt);
  return Number.isFinite(expires) && expires > now;
}
