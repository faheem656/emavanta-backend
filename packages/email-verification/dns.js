import { Resolver } from 'node:dns/promises';

/**
 * Domain-level DNS checks: MX first, A as fallback. ONE lookup serves every
 * address on the domain (the worker caches per-domain in email_domain_checks).
 *
 * States:
 *   ok         — records found (mx and/or a)
 *   nxdomain   — the domain does not exist (typo/fake)
 *   no_records — domain exists but has neither MX nor A (cannot receive mail)
 *   error      — temporary failure (SERVFAIL/timeout/…) → status ERROR, retry
 *
 * Private-IP guard: a domain whose only answers are RFC1918/loopback/link-local
 * addresses is treated as invalid for public email (and never contacted).
 */
export const DNS_TIMEOUT_MS = 4000;

let makeResolver = () => new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
/** Tests inject a fake resolver; production keeps the real one. */
export const __setResolverFactory = fn => { makeResolver = fn; };

const TEMP_DNS_CODES = new Set(['ENOTFOUND', 'ENODATA', 'ENOTDOMAIN']);

export const isPrivateIp = ip => {
  const v4 = String(ip || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  const v6 = String(ip || '').toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // ULA
  if (v6.startsWith('fe80')) return true; // link-local
  return false;
};

const query = async (fn) => {
  try {
    const value = await fn();
    return { ok: true, value: value || [] };
  } catch (e) {
    const code = String(e?.code || '');
    if (TEMP_DNS_CODES.has(code)) return { ok: true, value: [], missing: true, code };
    return { ok: false, code: code || 'DNS_ERROR', error: String(e?.message || e) };
  }
};

/**
 * @returns {Promise<{state: string, mx?: Array, a?: Array, private?: boolean,
 *   code?: string, error?: string}>}
 */
export const resolveDomain = async domain => {
  const d = String(domain || '').toLowerCase();
  if (!d) return { state: 'error', code: 'EMPTY', error: 'empty domain' };
  const resolver = makeResolver();
  const mxRes = await query(() => resolver.resolveMx(d));
  if (!mxRes.ok) return { state: 'error', code: mxRes.code, error: mxRes.error };
  const aRes = await query(() => resolver.resolve4(d));
  if (!aRes.ok) return { state: 'error', code: aRes.code, error: aRes.error };

  const mx = (mxRes.value || []).map(r => ({ exchange: String(r.exchange || '').toLowerCase().replace(/\.$/, ''), priority: Number(r.priority) || 0 }))
    .filter(r => r.exchange).sort((x, y) => x.priority - y.priority);
  const a = (aRes.value || []).map(String);

  if (mxRes.missing && aRes.missing) {
    // ENOTFOUND/EAI_NONAME = "no such domain" (negative → cacheable, INVALID).
    // ENODATA = the name EXISTS but has no records → no_records (also INVALID,
    // but a different reason). Mixed answers → the safer "exists" reading.
    const nx = c => c === 'ENOTFOUND' || c === 'EAI_NONAME';
    if (nx(mxRes.code) && nx(aRes.code)) return { state: 'nxdomain', code: mxRes.code || aRes.code };
    return { state: 'no_records', code: mxRes.code || aRes.code };
  }
  if (!mx.length && !a.length) return { state: 'no_records' };
  const allPrivate = a.length > 0 && mx.length === 0 && a.every(isPrivateIp);
  return { state: 'ok', mx, a, private: allPrivate };
};
