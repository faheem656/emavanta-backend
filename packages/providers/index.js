import { encryptSecret, decryptSecret } from '../security/encryption.js';
import { sendViaSmtp } from './smtp.js';
import { sendViaGoogle, sendViaMicrosoft } from './oauth-providers.js';
import { sendViaEsp } from './esp.js';
import { sendViaMock } from './mock.js';

export const normalizeAccount = account => ({ ...account, credentials: decryptSecret(account.encryptedCredentials) });

export const sendMessage = async (account, message) => {
  const a = normalizeAccount(account);
  switch (a.authMethod) {
    case 'google': return sendViaGoogle(a, message);
    case 'microsoft': return sendViaMicrosoft(a, message);
    case 'esp_api': return sendViaEsp(a, message);
    case 'smtp': return sendViaSmtp(a, message);
    case 'mock': if (process.env.NODE_ENV === 'test') return sendViaMock(a, message); throw new Error('Demo mailboxes are disabled.');
    default: throw new Error('Unsupported sending account.');
  }
};

export const encryptCredentials = value => encryptSecret(JSON.stringify(value));
export const decryptCredentials = value => { try { return JSON.parse(decryptSecret(value)); } catch { return {}; } };
export { verifyWebhookSignature, isReplay } from './webhooks.js';
