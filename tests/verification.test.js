import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSyntax, normalizeEmail, isDisposable, isRoleAccount, suggestDomain,
  resolveDomain, isPrivateIp, verifyEmail, isFresh, verificationGate,
  VERIFICATION_VERSION, __setResolverFactory, __setSmtpTransport
} from '../packages/email-verification/index.js';
import { processVerificationJob, enqueueVerification } from '../apps/api/src/workers/emailVerificationWorker.js';
import { collection, scoped } from '../packages/database/store.js';
import { closeQueues, hasPendingJob } from '../packages/queue/index.js';

/* ───────────────────────── pure layers ───────────────────────── */

test('syntax: valid shapes pass, malformed shapes fail with reasons', () => {
  assert.equal(checkSyntax('User@Example.COM').ok, true);
  assert.equal(normalizeEmail(' User@Example.COM '), 'user@example.com');
  assert.equal(checkSyntax('plainaddress').ok, false);
  assert.equal(checkSyntax('a@b').ok, false);            // no dot in domain
  assert.equal(checkSyntax('a..b@mail.com').ok, false);  // double dot
  assert.equal(checkSyntax('.a@mail.com').ok, false);
  assert.equal(checkSyntax('a@sub.mail.com').ok, true);
  assert.equal(checkSyntax('a@mail.invalidtld123').ok, false); // tld must be letters
  assert.equal(checkSyntax('').reason, 'empty');
});

test('disposable + role + typo dictionaries', () => {
  assert.equal(isDisposable('mailinator.com'), true);
  assert.equal(isDisposable('gmail.com'), false);
  assert.equal(isRoleAccount('info'), true);
  assert.equal(isRoleAccount('john'), false);
  const s = suggestDomain('gmal.com');
  assert.ok(s && s.domain === 'gmail.com' && s.distance === 1);
  assert.equal(suggestDomain('gmail.com'), null); // exact → no suggestion loop
  assert.equal(suggestDomain('completely-own-brand.test'), null);
});

test('private IP guard', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.1.2.3'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('169.254.0.1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false);
});

/* ───────────────────────── DNS + classifier ───────────────────────── */

const fakeDns = ({ mx = [], a = [], mxErr = null, aErr = null } = {}) => () => ({
  resolveMx: async () => { if (mxErr) { const e = new Error('dns'); e.code = mxErr; throw e; } return mx; },
  resolve4: async () => { if (aErr) { const e = new Error('dns'); e.code = aErr; throw e; } return a; }
});

test('classifier: NXDOMAIN → INVALID (typo suggestion when near a provider)', async () => {
  __setResolverFactory(fakeDns({ mxErr: 'ENOTFOUND', aErr: 'ENOTFOUND' }));
  const typo = await verifyEmail('user@gmal.com', { probe: false });
  assert.equal(typo.status, 'INVALID');
  assert.equal(typo.reason, 'domain_typo');
  assert.ok(typo.riskFlags.some(f => f.includes('gmail.com')));
  const fake = await verifyEmail('user@this-domain-does-not-exist-xyz.test', { probe: false });
  assert.equal(fake.status, 'INVALID');
  assert.equal(fake.reason, 'domain_not_found');
});

test('classifier: no MX/A → INVALID · MX → VALID · A-fallback → VALID+risk · SERVFAIL → ERROR (never INVALID)', async () => {
  __setResolverFactory(fakeDns({ mx: [], a: [], mxErr: 'ENODATA', aErr: 'ENODATA' }));
  const noMx = await verifyEmail('a@nomx.test', { probe: false });
  assert.equal(noMx.status, 'INVALID');
  assert.equal(noMx.reason, 'no_mx');

  __setResolverFactory(fakeDns({ mx: [{ exchange: 'mx1.test', priority: 10 }], a: ['1.2.3.4'] }));
  const ok = await verifyEmail('a@ok.test', { probe: false });
  assert.equal(ok.status, 'VALID');
  assert.equal(ok.checks.mxFound, true);
  assert.equal(ok.confidence, 'medium'); // no catch-all info

  __setResolverFactory(fakeDns({ mx: [], a: ['93.184.216.34'], mxErr: 'ENODATA' }));
  const aOnly = await verifyEmail('a@aonly.test', { probe: false });
  assert.equal(aOnly.status, 'VALID');
  assert.ok(aOnly.riskFlags.includes('a_record_fallback'));

  __setResolverFactory(fakeDns({ mxErr: 'SERVFAIL' }));
  const err = await verifyEmail('a@servfail.test', { probe: false });
  assert.equal(err.status, 'ERROR');            // retried, NEVER cached as INVALID
  assert.ok(err.reason.startsWith('dns_'));
});

test('classifier: private-IP-only domain → INVALID · role → RISKY · disposable → INVALID', async () => {
  __setResolverFactory(fakeDns({ mx: [], a: ['192.168.0.10'], mxErr: 'ENODATA' }));
  const priv = await verifyEmail('a@internal.test', { probe: false });
  assert.equal(priv.status, 'INVALID');
  assert.equal(priv.reason, 'private_ip_domain');

  __setResolverFactory(fakeDns({ mx: [{ exchange: 'mx.role.test', priority: 0 }], a: ['1.2.3.4'] }));
  const role = await verifyEmail('info@role.test', { probe: false });
  assert.equal(role.status, 'RISKY');
  assert.equal(role.reason, 'role_account');

  const disp = await verifyEmail('x@mailinator.com', { probe: false });
  assert.equal(disp.status, 'INVALID');
  assert.equal(disp.reason, 'disposable');
});

test('classifier: SMTP probe outcomes (catch-all + address-level, injected transport)', async () => {
  __setResolverFactory(fakeDns({ mx: [{ exchange: 'mx.ca.test', priority: 0 }], a: ['1.2.3.4'] }));

  // Domain accepts ANY local part → CATCH_ALL (address never probed).
  __setSmtpTransport(async (d, mx, address) => address ? 'exists' : 'catch_all');
  const ca = await verifyEmail('someone@ca.test');
  assert.equal(ca.status, 'CATCH_ALL');
  assert.equal(ca.catchAllHint, true);

  // Strict domain + address accepted → VALID with REAL mailbox proof.
  __setSmtpTransport(async (d, mx, address) => address ? 'exists' : 'rejects_unknown');
  const proven = await verifyEmail('someone@strict.test');
  assert.equal(proven.status, 'VALID');
  assert.equal(proven.reason, 'smtp_rcpt_verified');
  assert.equal(proven.confidence, 'high');       // the90%+ path
  assert.equal(proven.checks.mailboxProven, true);
  assert.equal(proven.catchAllHint, false);

  // Strict domain + address REJECTED (5xx) → definitive INVALID.
  __setSmtpTransport(async (d, mx, address) => address ? 'rejects' : 'rejects_unknown');
  const gone = await verifyEmail('nobody@strict.test');
  assert.equal(gone.status, 'INVALID');
  assert.equal(gone.reason, 'mailbox_not_found');
  assert.equal(gone.confidence, 'high');

  //4xx / greylist on the address → fail-soft: keep domain verdict, no INVALID.
  __setSmtpTransport(async (d, mx, address) => address ? 'tempfail' : 'rejects_unknown');
  const grey = await verifyEmail('maybe@strict.test');
  assert.equal(grey.status, 'VALID');
  assert.equal(grey.confidence, 'medium');
  assert.equal(grey.reason, 'domain_mx_ok');

  // Domain probe inconclusive → address probe skipped (same connection would
  // fail) → VALID medium, tri-state hint null, never UNKNOWN/INVALID.
  __setSmtpTransport(async () => 'inconclusive');
  const soft = await verifyEmail('someone@gray.test');
  assert.equal(soft.status, 'VALID');
  assert.equal(soft.confidence, 'medium');
  assert.equal(soft.catchAllHint, null);

  __setSmtpTransport(null);
  __setResolverFactory(null);
});

test('worker: bounced contact / suppression history → INVALID, FREE, no DNS', async () => {
  const org = `org-bounce-${Date.now()}`;
  await seedOrg(org);
  // (a) contact already marked bounced
  await scoped('contacts', { organizationId: org }).create({
    _id: `ct-b-${Date.now()}`, organizationId: org, email: 'gone@x.test',
    listIds: [], status: 'bounced'
  });
  const r1 = await processVerificationJob({ organizationId: org, email: 'gone@x.test' });
  assert.equal(r1.status, 'INVALID');
  assert.equal(r1.reason, 'suppressed_history');
  assert.equal(r1.suppressed, true);
  assert.equal(r1.charged, false);                 // bounce protection is FREE
  const row1 = await scoped('contacts', { organizationId: org }).findOne({ email: 'gone@x.test' });
  assert.equal(row1.verification.status, 'INVALID');
  assert.equal(row1.verification.reason, 'suppressed_history');

  // (b) suppression ledger hit (another address, contact still "active")
  await scoped('contacts', { organizationId: org }).create({
    _id: `ct-s-${Date.now()}`, organizationId: org, email: 'list1@x.test',
    listIds: [], status: 'active'
  });
  await scoped('suppressions', { organizationId: org }).create({
    _id: `sup-${Date.now()}`, email: 'list1@x.test', reason: 'bounced',
    createdAt: new Date().toISOString()
  });
  const r2 = await processVerificationJob({ organizationId: org, email: 'list1@x.test' });
  assert.equal(r2.status, 'INVALID');
  assert.equal(r2.charged, false);
  const counter = await collection('usage_counters').findOne({ _id: `${org}:2026-11` });
  assert.ok(!counter || !counter.verification_credits, 'suppression checks must never charge');
});

/* ───────────────────────── policy: TTL + gates ───────────────────────── */

test('freshness: INVALID permanent · VALID30d · PENDING never fresh · version bump stales', () => {
  const now = Date.now();
  assert.equal(isFresh({ status: 'INVALID', version: 1, verifiedAt: new Date(now - 900 * 86400000).toISOString() }, now), true);
  assert.equal(isFresh({ status: 'VALID', version: 1, verifiedAt: new Date(now - 29 * 86400000).toISOString() }, now), true);
  assert.equal(isFresh({ status: 'VALID', version: 1, verifiedAt: new Date(now - 31 * 86400000).toISOString() }, now), false);
  assert.equal(isFresh({ status: 'PENDING', version: 1 }, now), false);
  assert.equal(isFresh({ status: 'VALID', version: 99, verifiedAt: new Date(now).toISOString() }, now), false);
  assert.equal(isFresh(null, now), false);
});

test('send gate: INVALID/PENDING block · VALID passes · policy toggles · legacy no-record passes', () => {
  const ct = s => ({ verification: { status: s, version: 1, reason: 'x' } });
  assert.equal(verificationGate({ verification: null }, {}), null);            // legacy contact
  assert.equal(verificationGate({}, {}), null);                                 // no record
  assert.ok(verificationGate(ct('PENDING'), {}).hold);
  assert.equal(verificationGate(ct('PENDING'), {}).reason, 'verification_pending');
  assert.equal(verificationGate(ct('INVALID'), {}).reason, 'verification_invalid');
  assert.equal(verificationGate(ct('VALID'), {}), null);
  assert.equal(verificationGate(ct('CATCH_ALL'), {}).reason, 'verification_catch_all');
  assert.equal(verificationGate(ct('CATCH_ALL'), { verification: { allowCatchAll: true } }), null);
  assert.equal(verificationGate(ct('UNKNOWN'), {}).reason, 'verification_unknown');
  assert.equal(verificationGate(ct('UNKNOWN'), { verification: { allowUnknown: true } }), null);
  assert.equal(verificationGate(ct('RISKY'), {}), null);                        // default allowRisky
  assert.equal(verificationGate(ct('RISKY'), { verification: { allowRisky: false } }).reason, 'verification_risky');
  assert.equal(verificationGate(ct('ERROR'), {}).reason, 'verification_error');
});

/* ───────────────────────── worker: DB-first + credits ───────────────────────── */

const seedOrg = async (id, plan = 'free') => {
  await collection('organizations').create({ _id: id, plan, cycle: '2026-11', addons: {}, verifyCredits: 0, name: id });
};
const seedContact = async (org, email, verification) =>
  scoped('contacts', { organizationId: org }).create({
    _id: `ct-${org}-${Math.random().toString(36).slice(2, 8)}`,
    organizationId: org, email, listIds: [], status: 'active', ...(verification ? { verification } : {})
  });

test('worker: live run charges1 pack credit and writes KB + tenant verdict', async () => {
  const org = `org-vk-${Date.now()}`;
  await seedOrg(org, 'launch');
  await collection('organizations').updateOne({ _id: org }, { $set: { verifyCredits: 10 } }); // packs = the only source
  const contact = await seedContact(org, 'live@ok.test');
  __setResolverFactory(fakeDns({ mx: [{ exchange: 'mx.ok.test', priority: 0 }], a: ['1.2.3.4'] }));
  __setSmtpTransport(async (d, mx, address) => address ? 'exists' : 'rejects_unknown');

  const r = await processVerificationJob({ organizationId: org, email: 'live@ok.test', contactId: contact._id, source: 'test' });
  assert.equal(r.status, 'VALID');
  assert.equal(r.charged, true);

  const orgRow = await collection('organizations').findOne({ _id: org });
  assert.equal(orgRow.verifyCredits, 9); // pack balance decremented by1
  const kb = await collection('email_verifications').findOne({ emailNormalized: 'live@ok.test' });
  assert.ok(kb);
  assert.equal(kb.status, 'VALID');
  assert.equal(kb.firstSeenBy, org);
  const fresh = await scoped('contacts', { organizationId: org }).findOne({ _id: contact._id });
  assert.equal(fresh.verification.status, 'VALID');
  assert.equal(fresh.verification.version, VERIFICATION_VERSION);
  __setResolverFactory(null);
  __setSmtpTransport(null);
});

test('worker: same-tenant fresh duplicate is FREE (second run, no extra charge)', async () => {
  const org = `org-dup-${Date.now()}`;
  await seedOrg(org);
  const contact = await seedContact(org, 'dup@ok.test', { status: 'VALID', version: VERIFICATION_VERSION, verifiedAt: new Date().toISOString() });
  const r = await processVerificationJob({ organizationId: org, email: 'dup@ok.test', contactId: contact._id });
  assert.equal(r.duplicate, true);
  assert.equal(r.charged, false);
  const counter = await collection('usage_counters').findOne({ _id: `${org}:2026-11` });
  assert.ok(!counter || !counter.verification_credits, 'duplicate must not charge');
});

test('worker: cross-user KB hit CHARGES the second tenant and shares the verdict', async () => {
  const orgA = `org-kba-${Date.now()}`;
  const orgB = `org-kbb-${Date.now()}`;
  await seedOrg(orgA, 'launch'); await seedOrg(orgB, 'launch');
  await collection('organizations').updateOne({ _id: orgA }, { $set: { verifyCredits: 5 } });
  await collection('organizations').updateOne({ _id: orgB }, { $set: { verifyCredits: 5 } });
  const cA = await seedContact(orgA, 'shared@ok.test');
  __setResolverFactory(fakeDns({ mx: [{ exchange: 'mx.ok.test', priority: 0 }], a: ['1.2.3.4'] }));
  __setSmtpTransport(async (d, mx, address) => address ? 'exists' : 'rejects_unknown');
  await processVerificationJob({ organizationId: orgA, email: 'shared@ok.test', contactId: cA._id });

  const cB = await seedContact(orgB, 'shared@ok.test');
  const rB = await processVerificationJob({ organizationId: orgB, email: 'shared@ok.test', contactId: cB._id });
  assert.equal(rB.fromKb, true);
  assert.equal(rB.charged, true); //2nd user pays — locked rule
  const orgBRow = await collection('organizations').findOne({ _id: orgB });
  assert.equal(orgBRow.verifyCredits, 4); // charged from B's pack balance
  const kb = await collection('email_verifications').findOne({ emailNormalized: 'shared@ok.test' });
  assert.equal(kb.sharedCount, 1);
  const cBf = await scoped('contacts', { organizationId: orgB }).findOne({ _id: cB._id });
  assert.equal(cBf.verification.status, 'VALID'); // verdict reused, no DNS needed
  __setResolverFactory(null);
  __setSmtpTransport(null);
});

test('worker: UNKNOWN refunds the credit · ERROR never charges a verdict', async () => {
  const org = `org-unk-${Date.now()}`;
  await seedOrg(org, 'launch');
  await collection('organizations').updateOne({ _id: org }, { $set: { verifyCredits: 5 } });
  // DNS SERVFAIL → ERROR → the pack credit must come straight back.
  const c = await seedContact(org, 'temp@servfail.test');
  __setResolverFactory(fakeDns({ mxErr: 'SERVFAIL' }));
  const r = await processVerificationJob({ organizationId: org, email: 'temp@servfail.test', contactId: c._id });
  assert.equal(r.status, 'ERROR');
  assert.equal(r.charged, false); // refunded
  const orgRow = await collection('organizations').findOne({ _id: org });
  assert.equal(orgRow.verifyCredits, 5); // net zero — refund restored the pack
  __setResolverFactory(null);
});

test('worker: quota exceeded → PENDING quota_exceeded, never a silent pass', async () => {
  const org = `org-quota-${Date.now()}`;
  await seedOrg(org); // free plan includes NO credits and no pack was bought
  const c = await seedContact(org, 'over@quota.test');
  const r = await processVerificationJob({ organizationId: org, email: 'over@quota.test', contactId: c._id });
  assert.equal(r.quota, 'exceeded');
  const fresh = await scoped('contacts', { organizationId: org }).findOne({ _id: c._id });
  assert.equal(fresh.verification.status, 'PENDING');
  assert.equal(fresh.verification.reason, 'quota_exceeded');
  // The gate holds it:
  const gate = verificationGate(fresh, {});
  assert.equal(gate.reason, 'verification_pending');
});

test('paid plans include NO verification credits either — packs are the only source', async () => {
  const org = `org-pack-${Date.now()}`;
  await seedOrg(org, 'business'); // even Business (50k sends) →0 verification credits
  const c = await seedContact(org, 'pack@ok.test');
  const r = await processVerificationJob({ organizationId: org, email: 'pack@ok.test', contactId: c._id });
  assert.equal(r.quota, 'exceeded'); // no plan allowance, no pack → held

  // Buy a pack → unblocked, balance decremented, no cycle counter involved.
  await collection('organizations').updateOne({ _id: org }, { $set: { verifyCredits: 3 } });
  __setResolverFactory(fakeDns({ mx: [{ exchange: 'mx.ok.test', priority: 0 }], a: ['1.2.3.4'] }));
  __setSmtpTransport(async (d, mx, address) => address ? 'exists' : 'rejects_unknown');
  const r2 = await processVerificationJob({ organizationId: org, email: 'pack@ok.test', contactId: c._id });
  assert.equal(r2.status, 'VALID');
  assert.equal(r2.charged, true);
  const orgRow = await collection('organizations').findOne({ _id: org });
  assert.equal(orgRow.verifyCredits, 2); // pack balance decremented
  const counter = await collection('usage_counters').findOne({ _id: `${org}:2026-11` });
  assert.ok(!counter || !counter.verification_credits, 'plans include none — no cycle charge ever');
  __setResolverFactory(null);
  __setSmtpTransport(null);
});

test('free plan includes ZERO verification credits — quota until a pack is bought', async () => {
  const org = `org-free-${Date.now()}`;
  await seedOrg(org); // free → allowance is0 (user directive: "free me aik b na ho")
  const c = await seedContact(org, 'free@ok.test');
  const r = await processVerificationJob({ organizationId: org, email: 'free@ok.test', contactId: c._id });
  assert.equal(r.quota, 'exceeded');            // no cycle credit, no pack → held
  const held = await scoped('contacts', { organizationId: org }).findOne({ _id: c._id });
  assert.equal(held.verification.status, 'PENDING');
  assert.equal(held.verification.reason, 'quota_exceeded');

  // A pack unblocks it — pack balance is spent, verdict lands.
  await collection('organizations').updateOne({ _id: org }, { $set: { verifyCredits: 1 } });
  __setResolverFactory(fakeDns({ mx: [{ exchange: 'mx.ok.test', priority: 0 }], a: ['1.2.3.4'] }));
  __setSmtpTransport(async (d, mx, address) => address ? 'exists' : 'rejects_unknown');
  const r2 = await processVerificationJob({ organizationId: org, email: 'free@ok.test', contactId: c._id });
  assert.equal(r2.status, 'VALID');
  assert.equal(r2.charged, true);
  const orgRow = await collection('organizations').findOne({ _id: org });
  assert.equal(orgRow.verifyCredits, 0);        // pack balance spent
  __setResolverFactory(null);
  __setSmtpTransport(null);
});

test('enqueue: stable jobId dedupes concurrent requests for the same address', async () => {
  const ok1 = await enqueueVerification({ organizationId: 'org-enq', email: 'a@b.test' });
  const ok2 = await enqueueVerification({ organizationId: 'org-enq', email: 'a@b.test' });
  assert.equal(ok1, true);
  assert.equal(ok2, true);
  // One pending job with the stable id (second add is a no-op dedupe).
  assert.equal(await hasPendingJob('verify', 'verify:org-enq:a@b.test'), true);
  await closeQueues();
});
