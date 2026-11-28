/**
 * Typo dictionary: near-miss domains of the big providers.
 * `gmal.com`, `yaho.com`, `hotmial.com` — the domain does not resolve, but the
 * edit distance to a REAL provider domain is ≤2 → INVALID with a suggestion.
 * This is the cheap local version of what paid APIs charge for.
 */
const KNOWN = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'zoho.com',
  'yandex.com', 'yandex.ru', 'mail.ru', 'inbox.com', 'fastmail.com', 'fastmail.fm',
  'hey.com', 'tutanota.com', 'tuta.io', 'hostinger.com', 'email.com', 'usa.com',
  'rocketmail.com', 'ymail.com', 'hotmail.co.uk', 'live.co.uk', 'outlook.de'
];

/** Bounded Levenshtein — stops early once over the cap (cap=2, tiny strings). */
export const levenshtein = (a, b, cap = 2) => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
};

/**
 * @returns {{domain: string, distance: number} | null}
 * The nearest known provider domain within edit distance 2, else null.
 */
export const suggestDomain = domain => {
  const d = String(domain || '').toLowerCase();
  if (!d || d.length < 5) return null; // too short to guess safely
  if (KNOWN.includes(d)) return null; // already a provider domain — never "edit" away from it
  let best = null;
  for (const known of KNOWN) {
    const dist = levenshtein(d, known, 2);
    if (dist <= 2 && dist > 0 && (!best || dist < best.distance)) best = { domain: known, distance: dist };
    // same-length exact-prefix typos are the common case — stop early on hit
    if (best && best.distance === 1) break;
  }
  // Distance2 only counts when the strings are long enough to be a real typo.
  if (best && best.distance === 2 && d.length < 7) return null;
  return best;
};

export const KNOWN_DOMAINS = KNOWN;
