import { createHmac, timingSafeEqual } from 'node:crypto';
const secret = () => process.env.JWT_SECRET || 'demo-jwt-secret-change-in-production-32';
export const signLink = payload => {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
};
export const verifyLink = token => {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', secret()).update(body).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
};
export const safeRedirect = url => {
  try {
    const u = new URL(url);
    if (!['http:','https:'].includes(u.protocol)) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) return null;
    return u.toString();
  } catch { return null; }
};
