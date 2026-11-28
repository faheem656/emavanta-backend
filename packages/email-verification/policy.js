/**
 * Verification policy: TTLs (DB-first knowledge base), send gates and reason
 * codes. ONE place — intake, deliverOne and the worker all import from here so
 * the wizard/intake/runner can never disagree.
 */
import { VERIFICATION_VERSION } from './classifier.js';
export { VERIFICATION_VERSION };

/** Lifetime of a KB verdict (INVALID = permanent — never re-checked on optimism). */
export const VERIFICATION_TTL = {
  INVALID: null,        // permanent
  VALID: 30 * 86400000, // domain facts change
  CATCH_ALL: 7 * 86400000,
  RISKY: 7 * 86400000,
  UNKNOWN: 86400000,    // inconclusive → cheap retry next day
  ERROR: 30 * 60000     // retry fast, never cached as a verdict
};

export const ttlMs = status => (status in VERIFICATION_TTL ? VERIFICATION_TTL[status] : VERIFICATION_TTL.UNKNOWN);

/** Is a stored verdict still good enough to reuse without a live check? */
export const isFresh = (v, now = Date.now()) => {
  if (!v?.status || v.status === 'PENDING') return false;
  const version = Number(v.version ?? v.verificationVersion ?? 0);
  if (version !== VERIFICATION_VERSION) return false; // engine improved → stale
  if (v.status === 'INVALID') return true;             // permanent, never re-checked
  const ttl = ttlMs(v.status);
  const at = Date.parse(v.verifiedAt || v.createdAt || 0);
  if (!Number.isFinite(at)) return false;
  return now - at < ttl;
};

/** Default campaign policy — overridable per campaign via sendPolicy.verification. */
export const DEFAULT_SEND_POLICY = { allowUnknown: false, allowCatchAll: false, allowRisky: true };

/**
 * The send gate. Returns null = may send, or {hold:true, reason, note}.
 * A contact with NO verification record is a pre-feature legacy contact → null
 * (progressive rollout: contacts created by the new import flow always have a
 * PENDING record from second zero, so new lists are fully gated).
 */
export const verificationGate = (contact, sendPolicy) => {
  const v = contact?.verification;
  if (!v || !v.status) return null;
  const policy = { ...DEFAULT_SEND_POLICY, ...(sendPolicy?.verification || {}) };
  switch (v.status) {
    case 'PENDING':
      return { hold: true, reason: 'verification_pending',
        note: v.reason === 'quota_exceeded' ? 'Not enough verification credits.' : 'Verification is still running for this address.' };
    case 'INVALID':
      return { hold: true, reason: 'verification_invalid', note: v.reason || 'Address failed verification.' };
    case 'ERROR':
      return { hold: true, reason: 'verification_error', note: 'Verification hit a temporary error — it will retry automatically.' };
    case 'UNKNOWN':
      return policy.allowUnknown ? null
        : { hold: true, reason: 'verification_unknown', note: 'Verification could not confirm this address (policy: hold).' };
    case 'CATCH_ALL':
      return policy.allowCatchAll ? null
        : { hold: true, reason: 'verification_catch_all', note: 'Domain accepts any address — cannot confirm the mailbox (policy: hold).' };
    case 'RISKY':
      return policy.allowRisky ? null
        : { hold: true, reason: 'verification_risky', note: v.reason || 'Flagged risky (policy: hold).' };
    case 'VALID':
      return null;
    default:
      return null;
  }
};

/** Stable reason codes shown in reports/UI. */
export const GATE_REASONS = ['verification_pending', 'verification_invalid', 'verification_unknown',
  'verification_catch_all', 'verification_risky', 'verification_error'];
