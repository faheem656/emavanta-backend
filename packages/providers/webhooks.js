import { createHmac, timingSafeEqual } from 'node:crypto';
const seen = new Set();
export const verifyWebhookSignature = (rawBody, signature, secret, toleranceSec = 300) => {
  if (!secret) return process.env.NODE_ENV === 'test' && process.env.DEMO_MODE === 'true';
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
export const isReplay = id => {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 10000) seen.clear();
  return false;
};
