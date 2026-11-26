import { createContacts } from '../../../../packages/entitlements/contacts.js';
import { normalizeContactRow } from '../../../../packages/validation/index.js';
/**
 * Advanced platform layer: deliverability tools, outbox visibility, scheduler,
 * refresh sessions, streaming CSV imports, personalization registry,
 * SLO/metrics/runbooks and delivery reconciliation.
 *
 * NOTE: these are internal dashboard endpoints. We do NOT offer an email-sending API,
 * mailboxes or IPs. User-owned sending only.
 */
import { scoped, collection, isMemoryMode, withMongoTransaction } from '../../../../packages/database/store.js';
import { getQueue, publishOutbox } from '../../../../packages/queue/index.js';
import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { newId, stableHash } from '../../../../packages/shared/utils.js';
import { badRequest, notFound, forbidden } from '../../../../packages/shared/errors.js';
import { audit } from '../plugins/audit.js';
import { MAIL_STREAMS, dnsAdvice, verifyDns, classifyEvent, reputationScore, warmupPlan, seedPlacementScore } from '../../../../packages/deliverability/index.js';
import { acquireStream, resetRateLimiter } from '../../../../packages/rate-limiter/index.js';
import { newRefreshToken, rotateRefresh, tokenHash } from '../../../../packages/security/session.js';
import { sessionNotExpired, sessionExpiresAt } from '../../../../packages/security/session-policy.js';
import { config } from '../config.js';
import { importPreview } from '../../../../packages/email-engine/import.js';
import { renderText, extractTokens } from '../../../../packages/email-engine/personalization.js';
import { preflight } from '../../../../packages/email-engine/preflight.js';
import { SLOS, RTO_RPO, RUNBOOKS, METRICS } from '../../../../packages/observability/index.js';

export default async function advanced4Routes(app) {
  // ---------------------------------------------------------------- deliverability
  app.get('/deliverability/streams', async () => ({
    streams: MAIL_STREAMS, note: 'Keep transactional, marketing and outreach on separate user-owned accounts/domains.'
  }));
  app.post('/deliverability/dns/advice', async req => {
    const domain = String(req.body.domain || '').trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw badRequest('Valid domain required');
    return dnsAdvice(domain);
  });
  app.post('/deliverability/dns/verify', async req => {
    const domain = String(req.body.domain || '').trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw badRequest('Valid domain required');
    const result = req.ctx.demo ? { ...dnsAdvice(domain), checks: [{ name: domain, verified: false }, { name: `_dmarc.${domain}`, verified: false }], verified: false } : await verifyDns(domain);
    await scoped('dns_checks', req.ctx).create({ _id: newId(), domain, verified: result.verified, checks: result.checks, createdAt: new Date().toISOString() });
    return result;
  });
  app.post('/deliverability/events/classify', async req => {
    const result = classifyEvent(req.body || {});
    if (result.action === 'suppress' || result.action === 'suppress_and_pause') {
      if (req.body.email) await scoped('suppressions', req.ctx).create({ _id: newId(), email: req.body.email,
        reason: result.type, source: 'provider-webhook', createdAt: new Date().toISOString() });
    }
    return result;
  });
  app.get('/deliverability/reputation', async req => {
    const [events, accounts] = await Promise.all([scoped('delivery_events', req.ctx).find({}), scoped('sending_accounts', req.ctx).find({})]);
    const total = Math.max(events.length, 1);
    const counts = events.reduce((a, e) => ({ ...a, [e.type]: (a[e.type] || 0) + 1 }), {});
    const scored = accounts.map(a => ({ accountId: a._id, email: a.fromEmail, status: a.status,
      ...reputationScore({ bounceRate: (counts.bounced || 0) / total, complaintRate: (counts.complained || 0) / total,
        deferredRate: (counts.deferred || 0) / total, warmup: !!a.warmup, status: a.status }) }));
    return { accounts: scored, aggregate: reputationScore({ bounceRate: (counts.bounced || 0) / total,
      complaintRate: (counts.complained || 0) / total, deferredRate: (counts.deferred || 0) / total }),
      note: 'Reputation belongs to the customer. This is an advisory score based on observed events.' };
  });
  app.get('/deliverability/warmup-plan', async req => warmupPlan(Number(req.query.start || 10), Number(req.query.days || 14)));
  app.post('/deliverability/seed-tests', async req => {
    const seeds = (req.body.seedList || []).slice(0, 100);
    const scores = req.body.results ? seedPlacementScore(req.body.results) : null;
    const run = await scoped('seed_tests', req.ctx).create({ _id: newId(), seedList: seeds, status: scores ? 'ready' : 'queued',
      scores, campaignId: req.body.campaignId, createdAt: new Date().toISOString() });
    if (!scores) await getQueue('report').add('seed.test', { organizationId: req.ctx.organizationId, seedList: seeds }, { jobId: `seed-${run._id}` });
    return run;
  });
  app.get('/deliverability/seed-tests', async req => scoped('seed_tests', req.ctx).find({}, { sort: { createdAt: -1 }, limit: 50 }));
  app.post('/deliverability/rate-check', async req => {
    const result = await acquireStream({ organizationId: req.ctx.organizationId, ...req.body });
    return result;
  });

  // ---------------------------------------------------------------- transactional outbox
  app.get('/outbox/events', async req => collection('outbox_events')
    .find({ organizationId: req.ctx.organizationId }, { sort: { createdAt: -1 }, limit: Number(req.query.limit || 100) }));
  app.post('/outbox/:id/replay', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_SEND);
    const event = await collection('outbox_events').findOne({ _id: req.params.id, organizationId: req.ctx.organizationId });
    if (!event) throw notFound('Outbox event not found');
    await publishOutbox({ ...event, queue: event.queue || 'outbox', payload: { ...event.payload, eventId: event._id } });
    await collection('outbox_events').updateOne({ _id: event._id }, { $set: { status: 'published', publishedAt: new Date().toISOString() } });
    await audit(req.ctx, 'outbox.replay', 'outbox_event', { eventId: event._id });
    return { ok: true, eventId: event._id };
  });
  app.get('/outbox/batches/:campaignId', async req => scoped('campaign_batches', req.ctx).find({ campaignId: req.params.campaignId }));

  // ---------------------------------------------------------------- scheduler (long horizon)
  app.get('/scheduler/jobs', async req => scoped('scheduled_jobs', req.ctx).find({}, { sort: { runAt: 1 }, limit: 200 }));
  app.post('/scheduler/jobs', async req => {
    const { runAt, type = 'sequence.step', payload = {} } = req.body || {};
    if (!runAt || Number.isNaN(Date.parse(runAt))) throw badRequest('runAt must be an ISO date');
    const job = await scoped('scheduled_jobs', req.ctx).create({ _id: newId(), runAt, type, payload, status: 'pending',
      horizon: Date.parse(runAt) - Date.now() <= 24 * 3600_000 ? 'short' : 'long', createdAt: new Date().toISOString() });
    await getQueue('scheduler').add('scheduler.poll', { organizationId: req.ctx.organizationId }, { jobId: `poll-${req.ctx.organizationId}`, dedupe:false });
    return job;
  });
  app.post('/scheduler/poll', async req => {
    await getQueue('scheduler').add('scheduler.poll', { organizationId: req.ctx.organizationId }, { jobId: `poll-${req.ctx.organizationId}`, dedupe:false });
    return { ok: true };
  });

  // ---------------------------------------------------------------- refresh sessions
  app.get('/security/sessions', async req => {
    const rows = await collection('sessions').find({ organizationId: req.ctx.organizationId, status: 'active' },
      { sort: { createdAt: -1 }, limit: 100 });
    const now = Date.now(), active = [];
    for (const row of rows) {
      if (!sessionNotExpired(row, now, config.sessionTtlDays)) {
        await collection('sessions').updateOne({ _id: row._id, status: 'active' },
          { $set: { status: 'expired', expiredAt: new Date(now).toISOString(), revokedReason: 'ttl_expired' } });
        continue;
      }
      const { tokenHash: h, ...rest } = row;
      active.push({ ...rest, expiresAt: sessionExpiresAt(row, config.sessionTtlDays),
        current: !!req.ctx.sessionId && rest._id === req.ctx.sessionId,
        isSelf: rest.userId === req.ctx.user.id,
        device: rest.device || 'Unknown device' });
    }
    return active;
  });
  app.delete('/security/sessions', async req => {
    if (!req.ctx.sessionId || !['owner','admin','super_admin'].includes(req.ctx.user.role)) throw forbidden('Only owners and admins can sign out other sessions.');
    const keep = req.body?.keepCurrent ? (req.ctx.sessionId || null) : null;
    const rows = await collection('sessions').find({ organizationId: req.ctx.organizationId, status: 'active' });
    let revoked = 0;
    for (const row of rows) {
      if (keep && row._id === keep) continue;
      await collection('sessions').updateOne({ _id: row._id }, { $set: { status: 'revoked', revokedAt: new Date().toISOString() } });
      revoked++;
    }
    await audit(req.ctx, 'security.session.revoke_all', 'session', { revoked, keptCurrent: !!keep });
    return { ok: true, revoked };
  });
  app.post('/security/password', async req => {
    const { verifyPassword, hashPassword } = await import('../../../../packages/security/password.js');
    if (!req.ctx.sessionId || req.ctx.apiKeyId) throw forbidden('Sign in to change your password.');
    const current = String(req.body?.currentPassword || '');
    const next = String(req.body?.newPassword || '');
    if (next.length < 10 || next.length > 1024 || current.length > 1024) throw badRequest('New password must be 10–1024 characters');
    if (req.ctx.demo) throw badRequest('Password change is disabled in the demo workspace — sign up for a real workspace.');
    const user = await collection('users').findOne({ _id: req.ctx.user.id });
    if (!user || !(await verifyPassword(user.passwordHash, current))) throw badRequest('Current password is incorrect');
    const passwordHash=await hashPassword(next), now=new Date().toISOString();
    const apply=async (users,sessions,session) => {
      const opts=session ? {session} : undefined;
      const updated=await users.updateOne({_id:user._id,passwordHash:user.passwordHash},{$set:{passwordHash,passwordChangedAt:now}},opts);
      if(!updated.matchedCount) throw badRequest('Password changed in another session. Sign in and try again.');
      const result=await sessions.updateMany({userId:user._id,status:'active',_id:{$ne:req.ctx.sessionId}},{$set:{status:'revoked',revokedAt:now,revokedReason:'password_change'}},opts);
      return result.modifiedCount || 0;
    };
    const revoked=isMemoryMode() ? await apply(collection('users'),collection('sessions'))
      : await withMongoTransaction((db,session)=>apply(db.collection('users'),db.collection('sessions'),session));
    const { sendPasswordChangedMail } = await import('../mail-auth.js');
    void sendPasswordChangedMail(user.email);
    await audit(req.ctx, 'security.password.change', 'user', {});
    return { ok: true, signedOutOtherDevices: revoked };
  });
  app.post('/security/sessions', async req => {
    const familyId = newId();
    const { token, record } = newRefreshToken({ userId: req.ctx.user.id, organizationId: req.ctx.organizationId,
      familyId, ttlDays: config.sessionTtlDays });
    const created = await collection('sessions').create({ ...record, userAgent: req.headers['user-agent'] || 'unknown', ip: req.ip });
    return { refreshToken: token, sessionId: created._id, note: 'Store in httpOnly+Secure+SameSite=Lax cookie; never in localStorage.' };
  });
  app.post('/security/sessions/refresh', async req => {
    const token = req.body.refreshToken || req.cookies?.refresh_token;
    if (!token) throw badRequest('refreshToken required');
    const record = await collection('sessions').findOne({ tokenHash: tokenHash(token) });
    const rotated = rotateRefresh({ record, token });
    if (!rotated.ok) {
      if (rotated.reuse && record) await collection('sessions').updateMany({ familyId: record.familyId }, { $set: { status: 'revoked' } });
      await audit(req.ctx, 'security.session.reuse', 'session', { familyId: record?.familyId });
      throw badRequest('Refresh token reuse detected; family revoked');
    }
    await collection('sessions').updateOne({ _id: record._id }, { $set: { status: 'rotated', rotatedAt: new Date().toISOString() } });
    const created = await collection('sessions').create(rotated.session);
    return { ok: true, refreshToken: rotated.token, sessionId: created._id };
  });
  app.delete('/security/sessions/:id', async req => {
    if (!req.ctx.sessionId || !['owner','admin','super_admin'].includes(req.ctx.user.role)) throw forbidden('Only owners and admins can sign out sessions.');
    await collection('sessions').updateOne({ _id: req.params.id, organizationId: req.ctx.organizationId }, { $set: { status: 'revoked' } });
    return { ok: true };
  });
  app.get('/security/audit/verify', async req => {
    const { verifyChain } = await import('../plugins/audit.js');
    const logs = await collection('audit_logs').find({ organizationId: req.ctx.organizationId });
    const { broken, ordered } = verifyChain(logs);
    return { entries: ordered.length, intact: !broken, firstBrokenEntryId: broken?._id || null,
      algo: 'sha256(prevHash:action:resource:details)',
      note: 'Append-only hash chain in sequence order; immutable in production via DB trigger/Object Lock.' };
  });

  /** Repair a chain that was written before sequence-ordered hashing existed. Owner/admin only. */
  app.post('/security/audit/rechain', async req => {
    if (!['owner','admin','super_admin'].includes(req.ctx.user.role)) throw badRequest('Owner or admin required');
    const { rechain } = await import('../plugins/audit.js');
    const result = await rechain(req.ctx.organizationId);
    await audit(req.ctx, 'security.audit.rechain', 'audit_log', result);
    return { ok: true, ...result };
  });

  // ---------------------------------------------------------------- streaming CSV import
  app.post('/imports/csv', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    if (typeof req.body.csv !== 'string' || req.body.csv.length > 5_000_000) throw badRequest('csv required (max 5MB)');
    const ids = req.body.listIds || [];
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw badRequest('Choose valid lists.');
    for (const id of new Set(ids)) if (!await scoped('contact_lists', req.ctx).findOne({_id:id})) throw badRequest('Choose lists from this workspace.');
    const parsed = importPreview(req.body.csv, req.ctx.organizationId, [...new Set(ids)]);
    if (parsed.rows.length > 20000) throw badRequest('Import at most 20,000 rows per staged batch.');
    const batch = await scoped('import_batches', req.ctx).create({ _id: newId(), status: 'staged',
      rows: parsed.rows.slice(0, 20_000), errors: parsed.errors.slice(0, 1000), total: parsed.total,
      listIds: req.body.listIds || [], createdAt: new Date().toISOString() });
    return { batchId: batch._id, total: parsed.total, accepted: parsed.rows.length, rejected: parsed.errors.length };
  });
  app.get('/imports/:id', async req => {
    const batch = await scoped('import_batches', req.ctx).findOne({ _id: req.params.id });
    if (!batch) throw notFound('Import batch not found');
    return { ...batch, rows: batch.rows.slice(0, 20) };
  });
  app.post('/imports/:id/commit', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const batch = await scoped('import_batches', req.ctx).findOne({ _id: req.params.id });
    if (!batch || batch.status !== 'staged') throw badRequest('Batch is not staged');
    for (const id of batch.listIds || []) if (!await scoped('contact_lists', req.ctx).findOne({_id:id})) throw badRequest('A destination list no longer exists. Stage the import again.');
    const rows=batch.rows.map(row=>normalizeContactRow({ ...row,
      email:String(row.email).toLowerCase().trim(), firstName:row.first_name||row.firstName,
      lastName:row.last_name||row.lastName, company:row.company,
      customFields:row.custom_fields?{note:row.custom_fields}:{},
      listIds:batch.listIds||[], consentSource: 'import', consentIp: req.ip }));
    const result=await createContacts(req.ctx,rows);
    const created=result.created.length,duplicates=result.duplicates,addedToLists=result.addedToLists;
    await scoped('import_batches', req.ctx).updateOne({ _id: batch._id }, { $set: { status: 'committed', created, duplicates, committedAt: new Date().toISOString() } });
    await audit(req.ctx, 'contacts.import', 'import_batch', { created, duplicates });
    return { ok: true, created, duplicates, addedToLists };
  });
  app.post('/imports/:id/rollback', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const batch = await scoped('import_batches', req.ctx).findOne({ _id: req.params.id });
    if (!batch) throw notFound('Import batch not found');
    if (batch.status !== 'staged') throw badRequest('Only a staged batch can be discarded; committed contacts are not rolled back.');
    await scoped('import_batches', req.ctx).updateOne({ _id: batch._id }, { $set: { status: 'rolled_back' } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- personalization registry
  app.get('/personalization/tokens', async req => {
    const custom = await scoped('personalization_tokens', req.ctx).find({});
    return { builtIn: ['first_name','last_name','company','email','sender_name'], custom };
  });
  app.post('/personalization/tokens', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    if (!req.body.token || !/^[a-zA-Z0-9_.]+$/.test(req.body.token)) throw badRequest('Invalid token key');
    return scoped('personalization_tokens', req.ctx).create({ _id: newId(), token: req.body.token,
      label: req.body.label || req.body.token, source: req.body.source || 'contact.customFields',
      fallback: req.body.fallback || '', validation: req.body.validation || 'text' });
  });
  app.post('/personalization/preview', async req => {
    const { subject = '', html = '', sample = {} } = req.body || {};
    const tokens = extractTokens(subject) .concat(extractTokens(html));
    const rendered = { subject: renderText(subject, sample, { html: false }), html: renderText(html, sample) };
    const check = preflight({ subject, html, tokens: sample, unsubscribeUrl: 'https://track.emavanta.com/u/preview' });
    return { tokens: [...new Set(tokens)], rendered, check };
  });

  // ---------------------------------------------------------------- ops contracts
  app.get('/observability/slo', async () => ({ slos: SLOS, rtoRpo: RTO_RPO, runbooks: Object.keys(RUNBOOKS) }));
  app.get('/observability/metrics', async () => METRICS);
  app.get('/observability/runbooks', async () => RUNBOOKS);
  app.get('/observability/rate-limiter', async () => ({ algorithm: 'MongoDB compare-and-set token bucket',
    keys: 'tenant + stream + account + domain + lane', lanes: ['critical','outreach','bulk'], backpressure: 'scheduled 202 when queue lag exceeds SLO' }));
  app.post('/observability/rate-limiter/reset', async () => { resetRateLimiter(); return { ok: true }; });

  // ---------------------------------------------------------------- delivery reconciliation
  app.post('/reconciliation/run', async req => {
    const job = await getQueue('reconcile').add('reconcile.messages', { organizationId: req.ctx.organizationId },
      { jobId: `reconcile-${req.ctx.organizationId}` });
    return { ok: true, jobId: job.id || newId() };
  });
  app.get('/reconciliation/status', async req => scoped('reconciliation_runs', req.ctx).find({}, { sort: { createdAt: -1 }, limit: 20 }));
}
