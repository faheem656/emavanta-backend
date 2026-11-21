/** Envelope encryption: per-record DEK wrapped by a KEK (KMS in production). */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { encryptSecret, decryptSecret } from './encryption.js';

const keyId = () => process.env.KMS_KEY_ID || 'local-demo-kek-v1';
const kek = () => {
  const raw = process.env.KEK_SECRET || process.env.ENCRYPTION_KEY || 'demo-kms-kek-change-me';
  return createHash('sha256').update(raw).digest();
};

export const seal = value => {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const wrapped = encryptSecret(dek.toString('base64'));
  return { v: 2, keyId: keyId(), wrappedKey: wrapped, iv: iv.toString('base64'),
    ciphertext: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
};

export const unseal = envelope => {
  if (!envelope || envelope.v !== 2) return decryptSecret(envelope); // legacy records
  const dek = Buffer.from(decryptSecret(envelope.wrappedKey), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const text = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString();
  return JSON.parse(text);
};

export const rotateEnvelope = (envelope, value) => {
  const plain = value ?? unseal(envelope);
  return seal(plain);
};
