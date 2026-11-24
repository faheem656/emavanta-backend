
import {
  encryptSecret,
  decryptSecret
} from '../security/encryption.js';

import { sendViaSmtp } from './smtp.js';
import {
  sendViaGoogle,
  sendViaMicrosoft
} from './oauth-providers.js';

import { sendViaEsp } from './esp.js';
import { sendViaMock } from './mock.js';

/**
 * Encrypt credentials before database storage.
 */
export const encryptCredentials = value => {
  if (!value || typeof value !== 'object') {
    throw new Error('Credentials must be an object.');
  }

  return encryptSecret(JSON.stringify(value));
};

/**
 * Decrypt credentials from database storage.
 */
export const decryptCredentials = value => {
  if (!value) {
    return {};
  }

  try {
    const decrypted = decryptSecret(value);

    if (typeof decrypted !== 'string') {
      return {};
    }

    const parsed = JSON.parse(decrypted);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
};

/**
 * Normalize a stored sending account.
 * SMTP and other providers receive credentials as an object,
 * not as an encrypted string or JSON string.
 */
export const normalizeAccount = account => {
  if (!account) {
    throw new Error('Sending account is required.');
  }

  return {
    ...account,
    credentials: decryptCredentials(account.encryptedCredentials)
  };
};

/**
 * Send a message through the selected provider.
 */
export const sendMessage = async (account, message) => {
  if (!account) {
    throw new Error('Sending account is required.');
  }

  if (!message) {
    throw new Error('Message payload is required.');
  }

  const normalizedAccount = normalizeAccount(account);

  switch (normalizedAccount.authMethod) {
    case 'google':
      return sendViaGoogle(normalizedAccount, message);

    case 'microsoft':
      return sendViaMicrosoft(normalizedAccount, message);

    case 'esp_api':
      return sendViaEsp(normalizedAccount, message);

    case 'smtp':
      return sendViaSmtp(normalizedAccount, message);

    case 'mock':
      if (process.env.NODE_ENV === 'test') {
        return sendViaMock(normalizedAccount, message);
      }

      throw new Error('Demo mailboxes are disabled.');

    default:
      throw new Error('Unsupported sending account.');
  }
};

/**
 * Re-export webhook utilities.
 */
export {
  verifyWebhookSignature,
  isReplay
} from './webhooks.js';
