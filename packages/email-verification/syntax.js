/**
 * Address normalization + RFC-ish syntax validation.
 * Instant, zero-cost, zero-network — runs before anything else.
 */
export const normalizeEmail = email => String(email || '').trim().toLowerCase();

// Practical shape check: local@domain.tld (a dot in the domain is required —
// `user@localhost` is not a routable mailbox for our purposes).
const LOCAL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * @returns {{ok: true, local: string, domain: string} | {ok: false, reason: string}}
 */
export const checkSyntax = email => {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, reason: 'empty' };
  if (normalized.length > 254) return { ok: false, reason: 'too_long' };
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return { ok: false, reason: 'syntax_invalid' };
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (local.length > 64) return { ok: false, reason: 'syntax_invalid' };
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return { ok: false, reason: 'syntax_invalid' };
  if (!LOCAL_RE.test(local)) return { ok: false, reason: 'syntax_invalid' };
  if (domain.length > 253 || !domain.includes('.')) return { ok: false, reason: 'syntax_invalid' };
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(l => !DOMAIN_LABEL_RE.test(l)) || labels.some(l => l.length === 0)) {
    return { ok: false, reason: 'syntax_invalid' };
  }
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/i.test(tld)) return { ok: false, reason: 'syntax_invalid' };
  return { ok: true, local, domain };
};
