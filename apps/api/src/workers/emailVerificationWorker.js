import { collection, scoped } from '../../../../packages/database/store.js';
import { registerWorker, getQueue } from '../../../../packages/queue/index.js';
import { PLANS } from '../../../../packages/entitlements/definitions.js';
import {
  normalizeEmail, verifyEmail, isFresh, ttlMs, VERIFICATION_VERSION
} from '../../../../packages/email-verification/index.js';

/**
 * Verification worker (queue: `verify`) — DB-FIRST knowledge base + credits.
 *
 * Credit rules (LOCKED):
 *   1 credit = 1 email · duplicate (same tenant, fresh) = FREE · cross-user KB
 *   hit = CHARGED (the requesting user's own verification request) · UNKNOWN and
 *   ERROR = refund · ERROR auto-retries via its short TTL · quota: plan monthly
 *   allowance first, then the one-time pack balance (org.verifyCredits).
 *
 * The KB (`email_verifications`) is GLOBAL: one live run serves every tenant.
 * Only verdicts are shared — firstSeenBy is audit metadata, never exposed.
 *
 * CREDITS = PACKS ONLY (user directive): no plan includes verification credits.
 * The cycle-allowance branch below stays as a defensive no-op (allowance is0
 * for every plan) — it only fires if an admin ever grants a cycle allowance.
 */
const chargeCredit = async (organizationId, org) => {
  const cycle = String(org?.cycle || 'monthly');
  const ledgerId = `${organizationId}:${cycle}`;
  const allowance = Number(PLANS[org?.plan || 'free']?.limits?.verification_credits ?? 0);
  const usedDoc = await collection('usage_counters').findOne({ _id: ledgerId });
  const cycleUsed = Number(usedDoc?.verification_credits || 0);
  if (allowance === -1 || cycleUsed < allowance) {
    if (usedDoc) await collection('usage_counters').updateOne({ _id: ledgerId }, { $inc: { verification_credits: 1 } });
    else await collection('usage_counters').create({ _id: ledgerId, organizationId, cycle, verification_credits: 1 });
    return 'cycle';
  }
  if (Number(org?.verifyCredits || 0) > 0) {
    await collection('organizations').updateOne({ _id: organizationId }, { $inc: { verifyCredits: -1 } });
    return 'pack';
  }
  return null; // quota exceeded
};

/** Refund back to the exact source the charge came from. */
const refundTo = async (organizationId, org, source) => {
  if (source === 'cycle') {
    const ledgerId = `${organizationId}:${String(org?.cycle || 'monthly')}`;
    await collection('usage_counters').updateOne(
      { _id: ledgerId, verification_credits: { $gt: 0 } }, { $inc: { verification_credits: -1 } });
  } else if (source === 'pack') {
    await collection('organizations').updateOne({ _id: organizationId }, { $inc: { verifyCredits: 1 } });
  }
};

const domainOf = email => String(email).split('@')[1] || '';

/** Read the per-domain cache when fresh (one DNS pass serves thousands). */
const readDomainCache = async domain => {
  if (!domain) return null;
  try {
    const row = await collection('email_domain_checks').findOne({ domain });
    if (!row || !row.expiresAt || Date.parse(row.expiresAt) < Date.now()) return null;
    return row;
  } catch { return null; }
};

const writeDomainCache = async (domain, result, prev) => {
  if (!domain) return;
  const now = Date.now();
  // Only write when we actually LEARNED something about the domain: fresh DNS,
  // a DNS-level negative, or a probe result. (Syntax/disposable failures never
  // touched DNS — caching those would poison the domain for every other address.)
  const hasDns = !!result.domainInfo;
  const dnsNegative = result.status === 'INVALID' &&
    ['domain_not_found', 'domain_typo', 'no_mx', 'private_ip_domain'].includes(result.reason);
  const hasProbe = result.probeRan === true || result.catchAllHint !== undefined;
  if (!hasDns && !dnsNegative && !hasProbe) return;
  const state = hasDns ? 'ok'
    : dnsNegative ? (['domain_not_found', 'domain_typo'].includes(result.reason) ? 'nxdomain' : 'no_records')
    : (prev?.state || 'ok');
  const entry = {
    domain,
    state,
    mx: result.domainInfo?.mx ?? prev?.mx ?? [],
    a: result.domainInfo?.a ?? prev?.a ?? [],
    private: result.domainInfo?.private ?? prev?.private ?? false,
    catchAll: typeof result.catchAllHint === 'boolean' ? result.catchAllHint : (prev?.catchAll ?? null),
    probeDone: result.probeRan === true || prev?.probeDone === true || result.catchAllHint !== undefined,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 7 * 86400000).toISOString()
  };
  try {
    const existing = await collection('email_domain_checks').findOne({ domain });
    if (existing) await collection('email_domain_checks').updateOne({ _id: existing._id }, { $set: entry });
    else {
      const r = await collection('email_domain_checks').create({ _id: `dc:${domain}`, ...entry, createdAt: entry.checkedAt });
      if (r?.inserted === false) await collection('email_domain_checks').updateOne({ domain }, { $set: entry });
    }
  } catch { /* cache is best-effort */ }
};

/** Global KB upsert — verdicts only, permanent INVALID never expires. */
const writeKb = async (verdict, organizationId) => {
  const now = new Date().toISOString();
  const expiresAt = verdict.status === 'INVALID' ? null
    : new Date(Date.now() + ttlMs(verdict.status)).toISOString();
  const row = {
    emailNormalized: verdict.email, status: verdict.status, reason: verdict.reason,
    confidence: verdict.confidence, checks: verdict.checks || {}, riskFlags: verdict.riskFlags || [],
    verificationVersion: VERIFICATION_VERSION, source: 'live',
    verifiedAt: now, expiresAt, updatedAt: now
  };
  try {
    const existing = await collection('email_verifications').findOne({ emailNormalized: verdict.email });
    if (existing) {
      await collection('email_verifications').updateOne({ _id: existing._id },
        { $set: { ...row, firstSeenBy: existing.firstSeenBy || organizationId }, $inc: { verifyCount: 1 } });
      return;
    }
    const r = await collection('email_verifications').create({
      _id: `kv:${verdict.email}`, ...row, firstSeenBy: organizationId, verifyCount: 1, sharedCount: 0, createdAt: now
    });
    if (r?.inserted === false) {
      await collection('email_verifications').updateOne({ emailNormalized: verdict.email },
        { $set: row, $inc: { verifyCount: 1 } });
    }
  } catch { /* unique-index race → next run reconciles */ }
};

const writeTenantVerdict = async (organizationId, contact, verdict) => {
  const doc = {
    status: verdict.status, reason: verdict.reason, confidence: verdict.confidence,
    riskFlags: verdict.riskFlags || [], verifiedAt: new Date().toISOString(),
    version: VERIFICATION_VERSION
  };
  if (contact?._id) {
    await scoped('contacts', { organizationId }).updateOne({ _id: contact._id }, { $set: { verification: doc } });
  } else {
    await scoped('contacts', { organizationId }).updateOne(
      { email: verdict.email, deleted: { $ne: true } }, { $set: { verification: doc } });
  }
};

/** The handler — exported so tests can drive it directly (no queue pumping). */
export const processVerificationJob = async ({ organizationId, email, contactId, source = 'api' }) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return { skipped: 'empty' };
  const ctx = { organizationId };

  // 1) Tenant freshness → duplicate → FREE (no charge, no live run).
  const contact = contactId
    ? await scoped('contacts', ctx).findOne({ _id: contactId })
    : await scoped('contacts', ctx).findOne({ email: normalized, deleted: { $ne: true } });

  // 1) BOUNCE / COMPLAINT HISTORY IS AUTHORITATIVE — checked FIRST (before
  //     freshness and before any charge): a bounced address is INVALID no
  //     matter what an earlier check said — even a "fresh VALID" self-heals
  //     here, because the mailbox may still accept mail but we must never send.
  //     Bounce protection is ALWAYS FREE per the credit rules.
  const bounced = contact?.status === 'bounced' || contact?.status === 'complained';
  let suppressed = bounced;
  if (!suppressed) {
    try {
      const sup = await scoped('suppressions', ctx).findOne({ email: normalized, status: { $ne: 'expired' } });
      suppressed = !!(sup && /bounc|complain/i.test(String(sup.reason || '')));
    } catch { suppressed = false; }
  }
  if (suppressed) {
    await writeTenantVerdict(organizationId, contact, {
      status: 'INVALID', reason: 'suppressed_history', confidence: 'high',
      riskFlags: ['bounce_or_complaint_history']
    });
    return { status: 'INVALID', reason: 'suppressed_history', charged: false, suppressed: true };
  }

  // 2) Tenant freshness → duplicate → FREE (no charge, no live run).
  if (contact?.verification && isFresh(contact.verification)) {
    return { duplicate: true, status: contact.verification.status, charged: false };
  }

  // 2) Charge BEFORE work: plan monthly allowance → one-time pack balance.
  const org = await collection('organizations').findOne({ _id: organizationId }) || {};
  const chargedTo = await chargeCredit(organizationId, org);
  if (!chargedTo) {
    // Out of credits: keep the contact held (PENDING + quota reason) — never a
    // silent pass, never a charge.
    await writeTenantVerdict(organizationId, contact, { status: 'PENDING', reason: 'quota_exceeded' });
    return { quota: 'exceeded', charged: false };
  }

  try {
    // 3) DB-first: fresh global KB verdict → serve it (cross-user = charged).
    const kb = await collection('email_verifications').findOne({ emailNormalized: normalized });
    let verdict = null;
    if (kb && isFresh(kb)) {
      verdict = { email: normalized, status: kb.status, reason: kb.reason, confidence: kb.confidence,
        checks: kb.checks, riskFlags: kb.riskFlags || [], fromKb: true };
      if (kb.firstSeenBy && kb.firstSeenBy !== organizationId) {
        await collection('email_verifications').updateOne({ _id: kb._id }, { $inc: { sharedCount: 1 } });
      }
    } else {
      // 4) Live run — with the per-domain cache (DNS + catch-all probe shared).
      const domain = domainOf(normalized);
      const cached = await readDomainCache(domain);
      const opts = {};
      if (cached?.state) {
        opts.domainResult = { state: cached.state, mx: cached.mx || [], a: cached.a || [], private: !!cached.private };
        if (cached.probeDone) {
          if (typeof cached.catchAll === 'boolean') opts.catchAll = cached.catchAll;
          else opts.probe = false; // probed before but inconclusive — don't hammer
        }
      }
      verdict = await verifyEmail(normalized, opts);
      await writeKb(verdict, organizationId);
      await writeDomainCache(domain, verdict, cached);
    }

    // 5) Tenant view + refund rules.
    await writeTenantVerdict(organizationId, contact, verdict);
    let charged = true;
    if (verdict.status === 'UNKNOWN' || verdict.status === 'ERROR') {
      await refundTo(organizationId, org, chargedTo);
      charged = false;
    }
    return { status: verdict.status, reason: verdict.reason, charged, fromKb: !!verdict.fromKb, source };
  } catch (e) {
    // Unexpected failure → refund (never charge for work that didn't happen)
    // and leave the contact PENDING so the gate keeps holding it.
    await refundTo(organizationId, org, chargedTo).catch(() => {});
    throw e;
  }
};

export const startEmailVerificationWorker = () => registerWorker('verify', processVerificationJob);

/** Enqueue a verification (import, manual button, API). Stable jobId per
 *  tenant+address dedupes concurrent requests; `nonce` forces a fresh run
 *  (TTL refresh / manual re-check). */
export const enqueueVerification = async ({ organizationId, email, contactId, source = 'api', nonce = null }) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  try {
    await getQueue('verify').add('verify.contact',
      { organizationId, email: normalized, contactId: contactId || null, source },
      { jobId: nonce ? `verify:${organizationId}:${normalized}:${nonce}` : `verify:${organizationId}:${normalized}` });
    return true;
  } catch { return false; }
};
