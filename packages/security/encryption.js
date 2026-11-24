
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash
} from 'node:crypto';

const key = () => {
  // Keep the existing fallback for compatibility with previously
  // encrypted data. Production must configure ENCRYPTION_KEY.
  const raw =
    process.env.ENCRYPTION_KEY ||
    'demo-encryption-key-change-me-000000000000';

  return createHash('sha256').update(raw).digest();
};

/**
 * Encrypt a secret using AES-256-GCM.
 * Format: v1:iv:authTag:encryptedData
 */
export const encryptSecret = value => {
  if (value === undefined || value === null) {
    throw new Error('Cannot encrypt an empty secret.');
  }

  const iv = randomBytes(12);

  const cipher = createCipheriv(
    'aes-256-gcm',
    key(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url')
  ].join(':');
};

/**
 * Decrypt an AES-256-GCM secret.
 */
export const decryptSecret = payload => {
  if (typeof payload !== 'string' || !payload.startsWith('v1:')) {
    return payload;
  }

  const parts = payload.split(':');

  if (parts.length !== 4) {
    throw new Error('Invalid encrypted credential format.');
  }

  const [, iv, authTag, encryptedData] = parts;

  if (!iv || !authTag || !encryptedData) {
    throw new Error('Incomplete encrypted credential payload.');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(iv, 'base64url')
  );

  decipher.setAuthTag(
    Buffer.from(authTag, 'base64url')
  );

  const decrypted = Buffer.concat([
    decipher.update(
      Buffer.from(encryptedData, 'base64url')
    ),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
};

/**
 * Hash a token using SHA-256.
 */
export const hashToken = token => {
  return createHash('sha256')
    .update(token)
    .digest('hex');
};
