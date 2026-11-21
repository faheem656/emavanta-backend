/**
 * Card validation, saved-card tokens and simulated acquiring for self-hosted / demo
 * installations.
 *
 * Checkout always happens **inside the dashboard** — we never bounce the user to a
 * hosted payment page. A checkout session must be created AND paid before any plan
 * or add-on is applied; nothing is granted up front.
 *
 * Saved cards follow the same rule a real gateway enforces: the PAN and the CVC are
 * never stored. We keep a fingerprint (salted hash), the brand, the last four digits
 * and the expiry — enough to display "Visa •••• 4242" and to charge the token again.
 */

const onlyDigits = s => String(s || '').replace(/\D/g, '');

/** The card number is off by one → declined. Real acquirers do the same. */
export const luhnOk = number => {
  const digits = onlyDigits(number);
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

export const cardBrand = number => {
  const d = onlyDigits(number);
  if (/^4/.test(d)) return 'visa';
  if (/^5[1-5]/.test(d) || /^2(2[2-9]|[3-6]|7[01]|720)/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^6(?:011|5)/.test(d)) return 'discover';
  return 'card';
};

export const maskPan = number => {
  const d = onlyDigits(number);
  return d.length >= 4 ? `•••• ${d.slice(-4)}` : '••••';
};

const parseExpiry = (value, expMonth, expYear) => {
  const m = String(value || '').trim().match(/^(\d{1,2})\s*\/?\s*(\d{2}|\d{4})$/);
  let month; let year;
  if (m) {
    month = Number(m[1]);
    year = Number(m[2]);
  } else if (expMonth && expYear) {
    // callers that already split the fields (e.g. a Stripe element) are accepted too
    month = Number(expMonth);
    year = Number(expYear);
  } else return null;
  if (year < 100) year += 2000;
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  if (!Number.isFinite(year) || year < 2000 || year > 2100) return null;
  return { month, year };
};

const isFuture = ({ month, year }) => {
  const now = new Date();
  const endOfMonth = new Date(year, month, 1);
  return endOfMonth > new Date(now.getFullYear(), now.getMonth(), 1);
};

/**
 * Validates a card the way a payment form does before charging.
 * Returns every problem at once so the UI can point at the right field.
 */
export const validateCard = ({ number, expiry, cvc, name, expMonth, expYear } = {}) => {
  const errors = {};
  const digits = onlyDigits(number);
  const brand = cardBrand(digits);
  if (!digits) errors.number = 'Card number is required';
  else if (!luhnOk(digits)) errors.number = 'That card number is not valid';
  else if (brand === 'amex' ? digits.length !== 15 : digits.length !== 16) errors.number = `A ${brand} card has ${brand === 'amex' ? 15 : 16} digits`;

  const parsed = parseExpiry(expiry, expMonth, expYear);
  if (!expiry && !(expMonth && expYear)) errors.expiry = 'Expiry is required (MM/YY)';
  else if (!parsed) errors.expiry = 'Use the format MM/YY';
  else if (!isFuture(parsed)) errors.expiry = 'That card has expired';

  const code = onlyDigits(cvc);
  const need = brand === 'amex' ? 4 : 3;
  if (!code) errors.cvc = 'CVC is required';
  else if (code.length !== need) errors.cvc = `CVC is ${need} digits on this card`;

  if (!String(name || '').trim()) errors.name = 'Name on card is required';

  return { ok: Object.keys(errors).length === 0, errors, brand, last4: digits.slice(-4) };
};

/** Test cards the simulator recognises (documented in the checkout dialog). */
export const TEST_CARDS = Object.freeze({
  success: '4242424242424242',
  declined: '4000000000000002',
  insufficientFunds: '4000000000009995',
  processingError: '4000000000000119'
});

/**
 * Simulated charge. Deterministic and honest: a declined test card really fails,
 * and the caller only receives `ok:true` when the acquirer would have approved.
 */
export const chargeCard = ({ card, amount, currency = 'usd', description }) => {
  const check = validateCard(card);
  if (!check.ok) return { ok: false, code: 'CARD_INVALID', message: 'Check the card details', fields: check.errors };
  const digits = onlyDigits(card.number);
  if (digits === TEST_CARDS.declined) return { ok: false, code: 'CARD_DECLINED', message: 'Your card was declined. Try another card.' };
  if (digits === TEST_CARDS.insufficientFunds) return { ok: false, code: 'INSUFFICIENT_FUNDS', message: 'Not enough funds on this card.' };
  if (digits === TEST_CARDS.processingError) return { ok: false, code: 'PROCESSING_ERROR', message: 'The payment processor could not complete this charge. Nothing was taken.' };
  if (!(amount > 0)) return { ok: false, code: 'AMOUNT_INVALID', message: 'Nothing to charge for this change.' };
  return { ok: true, id: `ch_${Math.random().toString(36).slice(2, 12)}`, amount, currency,
    brand: check.brand, last4: check.last4, description, paidAt: new Date().toISOString(), test: true };
};

export const invoiceNumber = (seq = 1) => {
  const year = new Date().getFullYear();
  return `INV-${year}-${String(seq).padStart(4, '0')}`;
};

/* ------------------------------------------------------------------ */
/* Saved cards ("manage cards" in the billing page)                    */
/* ------------------------------------------------------------------ */

/** Stable, non-reversible id for a card: sha256 of the digits + expiry. Never the PAN. */
export const cardFingerprint = ({ number, expiry } = {}) => {
  const material = `${onlyDigits(number)}|${String(expiry || '').replace(/\s/g, '')}`;
  // Small, dependency-free hash (FNV-1a 64-bit style) — this is an id, not a secret.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < material.length; i++) {
    const c = material.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * (i + 7)) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
};

/** Everything we are allowed to keep about a card — and nothing more. */
export const cardSummary = card => {
  const check = validateCard(card);
  if (!check.ok) return { ok: false, fields: check.errors };
  const exp = parseExpiry(card.expiry);
  return { ok: true, brand: check.brand, last4: check.last4, expMonth: exp?.month, expYear: exp?.year,
    name: String(card.name || '').trim(), fingerprint: cardFingerprint(card),
    label: `${check.brand.charAt(0).toUpperCase()}${check.brand.slice(1)} •••• ${check.last4}` };
};

export const MAX_SAVED_CARDS = 10;

/**
 * Charging a saved card is a token charge: the card was validated and stored when it
 * was added, so the acquirer only needs the token. Declines still happen in reality —
 * the demo marks one fingerprint as always-declined so the UI path can be exercised.
 */
export const chargeStoredCard = ({ method, amount, currency = 'usd', description }) => {
  if (!method) return { ok: false, code: 'CARD_MISSING', message: 'Choose a saved card or add a new one.' };
  if (!(amount > 0)) return { ok: false, code: 'AMOUNT_INVALID', message: 'Nothing to charge for this change.' };
  const exp = { month: Number(method.expMonth), year: Number(method.expYear) };
  if (exp.month && exp.year && !isFuture(exp)) {
    return { ok: false, code: 'CARD_EXPIRED', message: 'That saved card has expired — add it again or use another card.' };
  }
  if (method.declines) return { ok: false, code: 'CARD_DECLINED', message: 'Your bank declined this saved card. Try another card.' };
  return { ok: true, id: `ch_${Math.random().toString(36).slice(2, 12)}`, amount, currency,
    brand: method.brand, last4: method.last4, description, paidAt: new Date().toISOString(),
    test: true, savedCardId: method._id };
};

/**
 * Is a saved card still chargeable?
 *
 * A card that was valid when it was saved does not stay valid forever, and a 402 on a
 * stored card that the user cannot deselect is a dead end: they retry, get the same
 * refusal, and the purchase never happens. So the API states it up front, and the
 * checkout never preselects a card it knows will fail.
 */
export const storedCardStatus = method => {
  if (!method) return { usable: false, reason: 'missing', message: 'That card is no longer on file.' };
  const month = Number(method.expMonth);
  const year = Number(method.expYear);
  if (month && year && !isFuture({ month, year })) {
    return { usable: false, reason: 'expired', message: 'This card has expired — add a new one.' };
  }
  if (method.declines) {
    return { usable: false, reason: 'declined', message: 'Your bank refused this card — use another one.' };
  }
  return { usable: true, reason: null, message: null };
};
