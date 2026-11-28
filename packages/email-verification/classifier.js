import { checkSyntax, normalizeEmail } from './syntax.js';
import { isDisposable } from './disposable.js';
import { isRoleAccount } from './role.js';
import { suggestDomain } from './typo.js';
import { resolveDomain } from './dns.js';
import { probeCatchAll, probeAddress } from './smtpProbe.js';

/**
 * The engine. Pure decision flow — no storage, no billing (the worker owns
 * those). Every branch maps to a stable status + reason code:
 *
 *   INVALID    — definite: syntax, disposable, NXDOMAIN (± typo), no MX/A, private IP
 *   VALID      — domain-level truth: MX (or A-fallback) exists, not disposable.
 *                HONEST NAMING: mailbox existence is UNPROVEN without SMTP RCPT.
 *   CATCH_ALL  — the domain accepted a random local part (probe, per-domain cached)
 *   RISKY      — role account (receives, but is a group inbox)
 *   UNKNOWN    — inconclusive server answer (greylisting etc.) — held, never INVALID
 *   ERROR      — temporary infrastructure failure (DNS SERVFAIL/timeout) — retried
 *
 * `opts.domainResult` / `opts.catchAll` come from the per-domain cache — when
 * present, NO DNS and NO SMTP probe runs (one lookup serves thousands).
 */
export const VERIFICATION_VERSION = 1;

const finish = (base, status, reason, confidence, extra = {}) => ({
  ...base, status, reason, confidence,
  checks: { ...base.checks, ...(extra.checks || {}) },
  riskFlags: [...base.riskFlags, ...(extra.riskFlags || [])],
  durationMs: Date.now() - base._startedAt
});

/**
 * @param {string} email
 * @param {{domainResult?: object, catchAll?: boolean|null, probe?: boolean,
 *          resolver?: function}} opts
 */
export const verifyEmail = async (email, opts = {}) => {
  const _startedAt = Date.now();
  const normalized = normalizeEmail(email);
  const base = { email: normalized, checks: { syntaxValid: false, domainValid: false, mxFound: false,
    disposable: false, roleBased: false, catchAll: false, aFallback: false },
    riskFlags: [], verificationVersion: VERIFICATION_VERSION, _startedAt };

  //1) Syntax — instant, free.
  const syntax = checkSyntax(normalized);
  if (!syntax.ok) return finish(base, 'INVALID', syntax.reason === 'empty' ? 'empty' : 'syntax_invalid', 'high');
  base.checks.syntaxValid = true;
  const { local, domain } = syntax;

  //2) Disposable — instant, free.
  if (isDisposable(domain)) {
    base.checks.disposable = true;
    return finish(base, 'INVALID', 'disposable', 'high');
  }

  //3) Domain / DNS (cached by the caller when possible).
  let dns = opts.domainResult || null;
  let domainInfo = null;
  if (!dns) {
    dns = await (opts.resolver || resolveDomain)(domain);
    if (dns.state === 'ok') domainInfo = { mx: dns.mx, a: dns.a, private: !!dns.private };
  }
  if (domainInfo) base.domainInfo = domainInfo; // the worker caches this per-domain
  if (dns.state === 'error') {
    // Temporary infrastructure failure — NEVER classified as INVALID (spec rule).
    return finish(base, 'ERROR', `dns_${String(dns.code || 'error').toLowerCase()}`, 'none');
  }
  if (dns.state === 'nxdomain') {
    const suggestion = suggestDomain(domain);
    if (suggestion) {
      base.riskFlags.push(`typo:did you mean ${suggestion.domain}?`);
      return finish(base, 'INVALID', 'domain_typo', 'high');
    }
    return finish(base, 'INVALID', 'domain_not_found', 'high');
  }
  if (dns.state === 'no_records') return finish(base, 'INVALID', 'no_mx', 'high');
  if (dns.private) return finish(base, 'INVALID', 'private_ip_domain', 'high');

  base.checks.domainValid = true;
  const hasMx = Array.isArray(dns.mx) && dns.mx.length > 0;
  const hasA = Array.isArray(dns.a) && dns.a.length > 0;
  if (!hasMx && !hasA) return finish(base, 'INVALID', 'no_mx', 'high');
  base.checks.mxFound = hasMx;
  if (!hasMx && hasA) {
    // A/AAAA fallback: allowed with a risk flag (plan rule) — confidence low.
    base.checks.aFallback = true;
    base.riskFlags.push('a_record_fallback');
  }

  //4) Role account — RISKY (receives mail, group inbox), never INVALID.
  if (isRoleAccount(local)) {
    base.checks.roleBased = true;
    return finish(base, 'RISKY', 'role_account', 'medium');
  }

  //5) Catch-all probe (per-domain, only when the caller didn't supply a cached
  //   answer and probing is allowed). Fail-soft → inconclusive keeps VALID.
  let catchAll = opts.catchAll;
  let probeRan = false;
  if (catchAll === undefined && opts.probe !== false && hasMx) {
    probeRan = true;
    const probeResult = await probeCatchAll(domain, dns.mx[0].exchange);
    // probeCatchAll speaks strings; the classifier speaks booleans (tri-state:
    // true/false/undefined). Inconclusive → no verdict change at all.
    catchAll = probeResult === 'inconclusive' ? undefined
      : probeResult === 'catch_all' ? true
        : probeResult === 'rejects_unknown' ? false
          : undefined;
  }
  base.probeRan = probeRan;
  // Tri-state hint for the per-domain cache: true/false when known, null when a
  // probe ran but was inconclusive, undefined when nothing ran.
  base.catchAllHint = probeRan
    ? (typeof catchAll === 'boolean' ? catchAll : null)
    : (typeof opts.catchAll === 'boolean' ? opts.catchAll : undefined);
  if (catchAll === true) {
    base.checks.catchAll = true;
    return finish(base, 'CATCH_ALL', 'catch_all', 'medium', { riskFlags: ['catch_all'] });
  }

  //5b) ADDRESS probe — the accuracy layer. On a strict domain (the server
  //     actively rejects unknown local parts), ask it about the ACTUAL address:
  //       250 → mailbox exists  (VALID, confidence high — this is the90%+ path)
  //       5xx → mailbox missing (INVALID — definitive)
  //       4xx/timeout → no verdict change (fail-soft, never INVALID)
  //     Skipped when: probing is off, no MX, catch-all already decided, or the
  //     domain probe itself just failed (same connection would fail too).
  const skipAddressProbe = opts.probe === false || opts.addressProbe !== undefined && !opts.addressProbe
    || !hasMx || catchAll === true || (probeRan && catchAll === undefined);
  if (!skipAddressProbe) {
    base.probeAddressRan = true;
    const addressResult = await probeAddress(domain, dns.mx[0].exchange, normalized);
    if (addressResult === 'exists') {
      base.checks.mailboxProven = true;
      return finish(base, 'VALID', 'smtp_rcpt_verified', 'high', { checks: { mailboxProven: true } });
    }
    if (addressResult === 'rejects') {
      base.checks.mailboxProven = false;
      return finish(base, 'INVALID', 'mailbox_not_found', 'high', { checks: { mailboxProven: false } });
    }
    // tempfail / inconclusive → keep the domain-level verdict below.
  }

  //6) Domain-level VALID — mailbox honestly unproven without SMTP RCPT.
  //    "high" is reserved for real mailbox proof (smtp_rcpt_verified above).
  const confidence = hasMx ? 'medium' : 'low';
  return finish(base, 'VALID', hasMx ? 'domain_mx_ok' : 'a_record_fallback', confidence);
};
