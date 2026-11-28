/**
 * Known disposable / temp-mail domains. Versioned so the knowledge base can
 * force a re-check when the list grows (verificationVersion coupling).
 * Deliberately a curated list, not a paid feed — see VERIFICATION_VERSION.
 */
export const DISPOSABLE_VERSION = '2026-11';

const LIST = new Set([
  'mailinator.com', 'mailinator.net', 'guerrillamail.com', 'guerrillamail.info', 'guerrillamail.net',
  'guerrillamail.org', 'sharklasers.com', 'grr.la', 'trashmail.com', 'trashmail.me', 'trashmail.net',
  'fakeinbox.com', 'fakeemail.com', 'throwawaymail.com', 'tempmail.com', 'temp-mail.org', 'tempmailo.com',
  'tempr.email', 'yopmail.com', 'yopmail.fr', 'yopmail.net', 'cool.fr.nf', 'jetable.org', 'nospam.ze.tc',
  '10minutemail.com', '10minutemail.net', 'minutemail.com', 'mohmal.com', 'burnermail.io', 'harakirimail.com',
  'tmail.ws', 'tmail.io', 'discard.email', 'discardmail.com', 'maildrop.cc', 'dropmail.me', 'sharklasers.com',
  'getnada.com', 'nada.email', 'emailondeck.com', '33mail.com', 'byom.de', 'wegwerfemail.de', 'tempmail.de',
  'dispostable.com', 'mailnesia.com', 'mailcatch.com', 'throwaway.email', 'tempr.email', 'dropmail.me',
  'spamgourmet.com', 'krun.ch', 'binkmail.com', 'safetymail.info', 'filzmail.com', 'mailforspam.com',
  'spam.lawyer', 'trashymail.com', 'mytemp.email', 'moakt.com', 'mymailoasis.com', 'inboxkitten.com',
  'mailinator.gq', 'secmail.com', 'emailias.com', 'boximail.com', 'getairmail.com', 'mailfly.de',
  'temporary-mail.net', 'tmpmail.net', 'tmpmail.org', 'dropmail.me', 'armyspy.com', 'cuvox.de',
  'dayrep.com', 'einrot.com', 'fleckens.hu', 'gustr.com', 'jourrapide.com', 'rhyta.com', 'superrito.com',
  'teleworm.us', 'laste.ml', 'rteet.com', 'discardmail.com', 'mailforspam.com', 'spam4.me'
]);

export const isDisposable = domain => LIST.has(String(domain || '').toLowerCase());
export const disposableSize = () => LIST.size;
export const DISPOSABLE_LIST = LIST;
