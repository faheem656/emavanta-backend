/**
 * In-house email verification engine — no paid APIs, no inbox guarantees.
 * Layers: syntax → disposable → role → typo → DNS (MX/A, private-IP guard) →
 * per-domain catch-all probe → classifier. The knowledge base (DB-first, shared
 * across tenants) and billing live in the worker; this package is pure.
 */
export { normalizeEmail, checkSyntax } from './syntax.js';
export { isDisposable, disposableSize, DISPOSABLE_VERSION } from './disposable.js';
export { isRoleAccount } from './role.js';
export { suggestDomain, levenshtein, KNOWN_DOMAINS } from './typo.js';
export { resolveDomain, isPrivateIp, __setResolverFactory, DNS_TIMEOUT_MS } from './dns.js';
export { probeCatchAll, probeAddress, __setSmtpTransport } from './smtpProbe.js';
export { verifyEmail, VERIFICATION_VERSION } from './classifier.js';
export { VERIFICATION_TTL, ttlMs, isFresh, DEFAULT_SEND_POLICY, verificationGate, GATE_REASONS } from './policy.js';
