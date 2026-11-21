/**
 * RFC 6238 TOTP — compatible with Google Authenticator, Authy, 1Password, etc.
 *
 * IMPORTANT: the `secret` in an otpauth:// URI MUST be Base32 (RFC 4648, A–Z 2–7).
 * An earlier build generated a base64url secret, which scans fine but produces
 * codes that Google Authenticator can never match. Secrets are Base32 now, and
 * any legacy base64url secret still verifies (see decodeSecret).
 */
import { randomBytes, createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = buf => {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = str => {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};

/** 20 random bytes → 32 chars of Base32 (what every authenticator app expects). */
export const generateSecret = () => base32Encode(randomBytes(20));

const looksBase32 = s => /^[A-Z2-7=\s]+$/i.test(String(s).replace(/=+$/, '')) && !/[-_]/.test(String(s));

/** Base32 first; falls back to the legacy base64url secrets of older workspaces. */
const decodeSecret = secret => {
  const raw = String(secret || '').trim();
  if (looksBase32(raw)) return base32Decode(raw);
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
};

export const totpCode = (secret, counter = Math.floor(Date.now() / 30000)) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', decodeSecret(secret)).update(buf).digest();
  const offset = h[h.length - 1] & 15;
  const code = ((h[offset] & 127) << 24 | h[offset + 1] << 16 | h[offset + 2] << 8 | h[offset + 3]) % 1000000;
  return String(code).padStart(6, '0');
};

/** ±1 step (30s) tolerance for clock drift, like Google's own server. */
export const verifyTotp = (secret, code, window = 1) => {
  const input = String(code || '').replace(/\D/g, '');
  if (input.length !== 6) return false;
  const now = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) if (totpCode(secret, now + i) === input) return true;
  return false;
};

/** Seconds until the current code expires — used by the UI countdown. */
export const secondsRemaining = (period = 30) => period - Math.floor((Date.now() / 1000) % period);

/** A well-formed otpauth:// URI (issuer first, then the account). */
export const otpauthUri = ({ secret, account, issuer = 'Emavanta', digits = 6, period = 30 }) => {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account || 'account')}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(period) });
  return `otpauth://totp/${label}?${params.toString()}`;
};
