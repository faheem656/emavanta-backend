import { randomUUID, createHash } from 'node:crypto';
export const newId = () => randomUUID();
export const stableHash = (...parts) => createHash('sha256').update(parts.join(':')).digest('hex');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
export const redact = (obj, keys = ['password','token','accessToken','refreshToken','apiKey','authorization']) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of Object.keys(out)) {
    if (keys.some(x => k.toLowerCase().includes(x.toLowerCase()))) out[k] = '[REDACTED]';
    else if (typeof out[k] === 'object') out[k] = redact(out[k], keys);
  }
  return out;
};
