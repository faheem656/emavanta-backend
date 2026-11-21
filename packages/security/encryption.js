import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
const key = () => {
  const raw = process.env.ENCRYPTION_KEY || 'demo-encryption-key-change-me-000000000000';
  return createHash('sha256').update(raw).digest();
};
/** Envelope-style AES-256-GCM. In production wrap the data key with KMS. */
export const encryptSecret = value => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
};
export const decryptSecret = payload => {
  if (!payload?.startsWith('v1:')) return payload;
  const [, iv, tag, data] = payload.split(':');
  if (!iv || !tag || !data) return '';
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
};
export const hashToken = token => createHash('sha256').update(token).digest('hex');
