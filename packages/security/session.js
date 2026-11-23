/** Opaque refresh-token families with rotation, reuse detection, and fixed absolute expiry. */
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

const secret = () => process.env.SESSION_SECRET || process.env.JWT_SECRET || 'demo-session-secret-change-me';
const usedTokens = new Set();
export const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');
export const signToken = payload => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
};
export const readToken = token => {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
};

export const newRefreshToken = ({ userId, organizationId, familyId, ttlDays = 30, expiresAt: absoluteExpiry }) => {
  const token = randomBytes(48).toString('base64url');
  const expiryMs = absoluteExpiry === undefined ? NaN : Date.parse(absoluteExpiry);
  const expiresAt = Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString()
    : new Date(Date.now() + ttlDays * 86400_000).toISOString();
  return { token, record: { tokenHash: tokenHash(token), userId, organizationId, familyId, expiresAt,
    status: 'active', createdAt: new Date().toISOString(), lastUsedAt: null, rotatedAt: null } };
};

/**
 * Returns { ok, session } on rotation, or { ok:false, reuse:true } when a
 * previously rotated token is presented -> the entire family must be revoked.
 */
export const rotateRefresh = ({ record, token, issuedAt = new Date().toISOString() }) => {
  if (!record || tokenHash(token) !== record.tokenHash) return { ok: false, reason: 'invalid' };
  if (usedTokens.has(record.tokenHash)) return { ok: false, reuse: true, reason: 'rotated' };
  if (record.status === 'revoked' || record.status === 'rotated') {
    return { ok: false, reuse: record.status === 'rotated', reason: record.status };
  }
  const expiryMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return { ok: false, reason: 'expired' };
  usedTokens.add(record.tokenHash);
  const next = newRefreshToken({ userId: record.userId, organizationId: record.organizationId,
    familyId: record.familyId, expiresAt: record.expiresAt });
  return { ok: true, token: next.token,
    session: { ...next.record, previousHash: record.tokenHash, rotatedAt: issuedAt } };
};
