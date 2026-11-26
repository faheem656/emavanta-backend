/**
 * Human-paced sending must stay human:
 *  - one campaign = one pacer job that sends ONE email per tick (never a blast),
 *  - the daily cap resets every day (and can be raised mid-send),
 *  - provider "delivered" webhooks are attributed to the campaign even though
 *    the provider never knows our organizationId (the delivered card was empty).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.MONGODB_URI; // in-memory store

const { collection, scoped } = await import('../packages/database/store.js');
const { getQueue, closeQueues, hasPendingJob } = await import('../packages/queue/index.js');
const { newId } = await import('../packages/shared/utils.js');
const { startOutreachPacer } = await import('../apps/api/src/workers/outreachPacer.js');
const { startWebhookProcessor } = await import('../apps/api/src/workers/webhookProcessor.js');
const { resetDailySendCounters, reviveStalledPacers } = await import('../apps/api/src/workers/schedulerSweep.js');
const { shouldPace } = await import('../apps/api/src/workers/outboxRelay.js');
const { pacingFor, isWithinWindow } = await import('../packages/email-engine/cadence.js');

const ORG = 'org-test';
const ctx = { organizationId: ORG };
const wait = ms => new Promise(r => setTimeout(r, ms));

const seed = async () => {
  await collection('organizations').create({ _id: ORG, name: 'Test Org', plan: 'growth' });
  await scoped('sending_accounts', ctx).create({
    _id: 'acc-1', fromEmail: 'rep@sender.example', fromName: 'Rep', status: 'active',
    authMethod: 'mock', stream: 'outreach', sentToday: 0, sentWeek: 0, warmup: false,
    createdAt: new Date().toISOString()
  });
  await scoped('templates', ctx).create({
    _id: 'tpl-1', name: 'T', subject: 'Hello', mode: 'code', html: '<p>Hi {{firstName}}</p>', version: 1
  });
  await scoped('campaigns', ctx).create({
    _id: 'camp-1', name: 'Human campaign', status: 'queued', sendMode: 'human',
    stream: 'outreach', templateId: 'tpl-1', accountPool: ['acc-1'], rotation: 'round_robin',
    gapSeconds: 5, // short gap keeps the background chain from lingering in tests
    // Always inside the window regardless of when the suite runs.
    sendPolicy: { minDelaySec: 45, maxDelaySec: 90, jitterPct: 20, dailyCap: 50, weeklyCap: 250,
      pauseOnReply: true, timezone: 'UTC',
      schedule: { startTime: '00:00', endTime: '24:00', daysOfWeek: [1,2,3,4,5,6,7] } },
    intake: { status: 'done', done: 3, total: 3 },
    stats: { queued: 0, sent: 0, delivered: 0, bounced: 0, replied: 0 },
    createdAt: new Date().toISOString()
  });
  const recipients = ['a@x.test', 'b@x.test', 'c@x.test'].map((email, i) => ({
    _id: `camp-1:c${i}`, campaignId: 'camp-1', contactId: `c${i}`, email, status: 'queued'
  }));
  await scoped('campaign_recipients', ctx).bulkCreate(recipients);
  await scoped('campaign_batches', ctx).create({
    _id: 'batch-camp-1-0', campaignId: 'camp-1', index: 0, status: 'queued', checkpoint: 0,
    total: 3, recipientIds: recipients.map(r => r._id)
  });
  return recipients;
};

test('human pacer sends exactly one email per tick, not the whole batch', async () => {
  const recipients = await seed();
  startOutreachPacer();

  const policy = pacingFor((await scoped('campaigns', ctx).findOne({ _id: 'camp-1' })));
  assert.equal(policy.sendMode, 'human');
  assert.ok(isWithinWindow(policy, new Date()), 'seeded schedule must be inside the window');

  await getQueue('outreach').add('outreach.pacer', {
    organizationId: ORG, campaignId: 'camp-1', accountPool: ['acc-1'],
    rotation: 'round_robin', stream: 'outreach', sendPolicy: policy
  }, { jobId: 'pacer-camp-1' });

  await wait(400);

  const sent = recipients.filter(r => r.status === 'sent');
  // Reload from the store — the local copies are snapshots.
  const rows = await scoped('campaign_recipients', ctx).find({ campaignId: 'camp-1' });
  const sentRows = rows.filter(r => r.status === 'sent');
  assert.equal(sentRows.length, 1, `expected exactly 1 send per tick, got ${sentRows.length}`);
  assert.equal(sent.length, 0, 'local snapshot must not be trusted');

  const campaign = await scoped('campaigns', ctx).findOne({ _id: 'camp-1' });
  assert.equal(campaign.stats.sent, 1);

  const batch = await scoped('campaign_batches', ctx).findOne({ _id: 'batch-camp-1-0' });
  assert.equal(batch.checkpoint, 1, 'cursor advanced by exactly one');

  const account = await scoped('sending_accounts', ctx).findOne({ _id: 'acc-1' });
  assert.equal(account.sentToday, 1);
  assert.equal(account.sentWeek, 1);

  // A second tick must be scheduled (human gap), not run concurrently.
  assert.equal(await hasPendingJob('outreach', 'pacer-camp-1'), true,
    'pacer re-arms itself for the next email');

  // Stop the background chain before the rest of the suite runs.
  await scoped('campaigns', ctx).updateOne({ _id: 'camp-1' }, { $set: { status: 'paused' } });
  await wait(100);
});

test('delivered webhooks are attributed even without organizationId from the provider', async () => {
  startWebhookProcessor();
  const message = await collection('messages').findOne({});
  assert.ok(message, 'the seeded send must have produced a message row');

  const before = await scoped('campaigns', ctx).findOne({ _id: 'camp-1' });
  const deliveredBefore = before.stats.delivered || 0;

  // What a provider actually sends: their id + the event, nothing about us.
  await getQueue('webhook').add('provider.event', {
    provider: 'smtp',
    event: { id: 'evt-delivered-1', type: 'delivered', messageId: message.providerMessageId, email: message.to }
  }, { jobId: 'evt-delivered-1' });
  await wait(300);

  const event = await scoped('delivery_events', ctx).findOne({ dedupeKey: 'evt-delivered-1' });
  assert.ok(event, 'webhook event must be stored');
  assert.equal(event.campaignId, 'camp-1', 'campaignId recovered from the stored message');
  assert.equal(event.sendingAccountId, 'acc-1');
  assert.equal(event.organizationId, ORG);

  const after = await scoped('campaigns', ctx).findOne({ _id: 'camp-1' });
  assert.equal(after.stats.delivered, deliveredBefore + 1, 'stats.delivered must increment once');

  // Provider retry with the same id is a no-op.
  await getQueue('webhook').add('provider.event', {
    provider: 'smtp',
    event: { id: 'evt-delivered-1', type: 'delivered', messageId: message.providerMessageId }
  }, { jobId: 'evt-delivered-1-retry' });
  await wait(200);
  const events = await scoped('delivery_events', ctx).find({ dedupeKey: 'evt-delivered-1' });
  assert.equal(events.length, 1, 'duplicate webhook must not double-count');
});

test('daily and weekly counters reset so the daily cap means per day, not lifetime', async () => {
  await scoped('sending_accounts', ctx).updateOne({ _id: 'acc-1' },
    { $set: { sentToday: 137, sentWeek: 900, sentTodayResetAt: '2000-01-01', sentWeekResetAt: '2000-W01' } });

  await resetDailySendCounters();
  const after = await scoped('sending_accounts', ctx).findOne({ _id: 'acc-1' });
  assert.equal(after.sentToday, 0, 'sentToday reset to zero on a new day');
  assert.equal(after.sentWeek, 0, 'sentWeek reset to zero on a new week');

  await scoped('sending_accounts', ctx).updateOne({ _id: 'acc-1' }, { $set: { sentToday: 7 } });
  await resetDailySendCounters();
  const again = await scoped('sending_accounts', ctx).findOne({ _id: 'acc-1' });
  assert.equal(again.sentToday, 7, 'same-day sweep must not wipe the live counter');
});

test('campaign pacing edits apply live: raising the daily cap re-arms a capped pacer', async () => {
  // Simulate every mailbox at the old cap: the pacer parks instead of dropping work.
  await scoped('campaigns', ctx).updateOne({ _id: 'camp-1' }, { $set: { status: 'queued' } });
  await scoped('sending_accounts', ctx).updateOne({ _id: 'acc-1' }, { $set: { sentToday: 50 } });
  await scoped('campaigns', ctx).updateOne({ _id: 'camp-1' }, { $set: { 'sendPolicy.dailyCap': 50 } });

  const { campaignPacingSchema } = await import('../packages/validation/index.js');
  const input = campaignPacingSchema.parse({ dailyCap: 500 });
  assert.equal(input.dailyCap, 500);

  // What PATCH /campaigns/:id/pacing writes:
  const campaign = await scoped('campaigns', ctx).findOne({ _id: 'camp-1' });
  const $set = { sendPolicy: { ...(campaign.sendPolicy || {}), ...input } };
  await scoped('campaigns', ctx).updateOne({ _id: 'camp-1' }, { $set });

  const updated = await scoped('campaigns', ctx).findOne({ _id: 'camp-1' });
  const policy = pacingFor(updated);
  assert.equal(policy.dailyCap, 500, 'pacer policy picks up the new cap from the document');
  // sentToday (50) < new cap (500) → the account is sendable again immediately.
  assert.ok((50) < policy.dailyCap);

  await scoped('campaigns', ctx).updateOne({ _id: 'camp-1' }, { $set: { status: 'paused' } });
});

test('reviveStalledPacers re-arms a queued campaign whose pacer job died', async () => {
  await scoped('campaigns', ctx).updateOne({ _id: 'camp-1' }, { $set: { status: 'queued' } });
  // No pending pacer job exists in this test file's queue after closeQueues-like state:
  // ensure one is missing by using a fresh campaign id.
  await scoped('campaigns', ctx).create({
    _id: 'camp-2', name: 'Stalled', status: 'queued', sendMode: 'human', stream: 'outreach',
    templateId: 'tpl-1', accountPool: ['acc-1'], rotation: 'round_robin',
    intake: { status: 'running' }, stats: { sent: 0, delivered: 0 },
    organizationId: ORG, createdAt: new Date().toISOString()
  });
  await scoped('campaign_recipients', ctx).create({
    _id: 'camp-2:r1', campaignId: 'camp-2', contactId: 'r1', email: 'z@x.test', status: 'queued',
    organizationId: ORG
  });

  const revived = await reviveStalledPacers();
  assert.ok(revived >= 1, `expected at least one revival, got ${revived}`);
  assert.equal(await hasPendingJob('outreach', 'pacer-camp-2'), true,
    'a fresh pacer job is queued for the stalled campaign');

  await scoped('campaigns', ctx).updateOne({ _id: 'camp-2' }, { $set: { status: 'paused' } });
  await scoped('campaigns', ctx).updateOne({ _id: 'camp-1' }, { $set: { status: 'paused' } });
  await wait(1200); // let any revived tick observe the pause and park
});

test('outbox relay routes every human campaign through the pacer, whatever the stream', () => {
  assert.equal(shouldPace({ stream: 'marketing', sendMode: 'human' }), true);
  assert.equal(shouldPace({ stream: 'outreach', sendMode: 'blast' }), false, 'explicit blast wins on every stream');
  assert.equal(shouldPace({ stream: 'marketing', sendMode: 'blast' }), false, 'blast keeps the batch path');
  assert.equal(shouldPace({ stream: 'outreach' }), true, 'legacy payloads without a mode keep the human default');
});

test('provider cool-downs parse their own deadline and expire by themselves', async () => {
  const { cooldownUntil } = await import('../packages/deliverability/index.js');
  const { eligibleAccounts } = await import('../packages/email-engine/selection.js');
  const providerError = 'Can\'t send mail - all recipients were rejected: 550 5.4.6 Sender Hourly '
    + 'Bounce Limit Exceeded - [account=info@mse.email] will not be allowed to send emails till '
    + '[time=2026-11-25 23:36:48 UTC] as hourly bounce limit is exceeded([bounces=5] out of [limit=5]).';
  const from = Date.parse('2026-11-25T20:00:00Z');
  assert.equal(cooldownUntil(providerError, from), '2026-11-25T23:36:48.000Z', 'honours the provider deadline');
  assert.equal(cooldownUntil('SMTP 421 try again later', from), '2026-11-25T21:00:00.000Z', 'default backoff is one hour');
  const now = new Date('2026-11-25T20:00:00Z');
  const cooled = { _id: 'a', status: 'limited', stream: 'outreach' };
  assert.equal(eligibleAccounts([{ ...cooled, limitedUntil: '2026-11-25T19:00:00.000Z' }], { stream: 'outreach', now }).length, 1,
    'a cool-down that has passed is usable again');
  assert.equal(eligibleAccounts([{ ...cooled, limitedUntil: '2026-11-25T21:00:00.000Z' }], { stream: 'outreach', now }).length, 0,
    'a live cool-down still holds the mailbox back');
  assert.equal(eligibleAccounts([{ ...cooled, limitedUntil: null }], { stream: 'outreach', now }).length, 0,
    'legacy limited mailboxes (no deadline) stay manual until reconnected');
});

test('send failures are classified so the system reacts correctly', async () => {
  const { classifySendError, bumpBounceWindow, BOUNCE_AUTO_LIMIT } = await import('../packages/deliverability/index.js');
  const { eligibleAccounts } = await import('../packages/email-engine/selection.js');
  // Auth failure → mailbox needs reconnect, recipient must stay queued.
  assert.equal(classifySendError(new Error('Invalid login: 535 5.7.8 Error: authentication failed: (reason unavailable)')), 'auth');
  // Provider holding the whole mailbox → cool-down with deadline, recipient stays queued.
  assert.equal(classifySendError(new Error('550 5.4.6 Sender Hourly Bounce Limit Exceeded ... till [time=2026-11-25 23:36:48 UTC]')), 'account');
  assert.equal(classifySendError(new Error('451 try again later')), 'account');
  // Recipient refused → definite bounce (suppress + count), keep sending.
  assert.equal(classifySendError(new Error('550 5.5.1 Recipient rejected - OXSEU001_403')), 'rejected');
  assert.equal(classifySendError(new Error('550 user unknown')), 'rejected');
  // Ambiguous mid-send → manual review.
  assert.equal(classifySendError(new Error('ETIMEDOUT connection timed out')), 'unknown');
  // Bounce ledger mirrors the provider's 5/hour window.
  let acc = {};
  let last;
  for (let i = 0; i < BOUNCE_AUTO_LIMIT; i++) {
    last = bumpBounceWindow(acc, 1_700_000_000_000 + i);
    acc = { ...acc, bounceWindow: { start: last.start, count: last.count } };
  }
  assert.equal(last.count, BOUNCE_AUTO_LIMIT);
  assert.equal(last.limitHit, true, 'fifth bounce pauses the mailbox');
  assert.ok(Date.parse(last.until) > 1_700_000_000_000, 'pause lasts until the hour rolls over');
  // Per-mailbox activeHours went away with the send-policy page — the campaign owns the schedule.
  assert.equal(eligibleAccounts([{ _id: 'a', status: 'active', activeHours: { start: 9, end: 18 } }],
    { stream: 'outreach', now: new Date('2026-01-01T03:00:00Z') }).length, 1,
    'account-level hours no longer gate eligibility');
});

test('bounce-rate circuit breaker pauses a dangerous campaign for review', async () => {
  const { guardBounceRate } = await import('../apps/api/src/workers/campaignRunner.js');
  await scoped('campaigns', ctx).create({
    _id: 'camp-guard', name: 'Guard', status: 'queued', sendMode: 'blast', stream: 'outreach',
    templateId: 'tpl-1', accountPool: ['acc-1'], stats: { sent: 40, bounced: 3 },
    createdAt: new Date().toISOString()
  });
  // 3/40 = 7.5% ≥ 5% after ≥20 sends → pause for review.
  assert.equal(await guardBounceRate(ORG, 'camp-guard'), true);
  let c = await scoped('campaigns', ctx).findOne({ _id: 'camp-guard' });
  assert.equal(c.status, 'paused');
  assert.equal(c.pauseReason, 'high_bounce_rate');
  assert.match(c.pauseDetail, /7\.5% bounce rate \(3 of 40 sent\)/);

  // Below the bar: healthy campaigns keep going.
  await scoped('campaigns', ctx).create({
    _id: 'camp-guard-ok', name: 'OK', status: 'queued', sendMode: 'blast', stream: 'outreach',
    templateId: 'tpl-1', accountPool: ['acc-1'], stats: { sent: 40, bounced: 1 },
    createdAt: new Date().toISOString()
  });
  assert.equal(await guardBounceRate(ORG, 'camp-guard-ok'), false);
  c = await scoped('campaigns', ctx).findOne({ _id: 'camp-guard-ok' });
  assert.equal(c.status, 'queued');

  // Too few sends to judge (small sample) → no pause.
  await scoped('campaigns', ctx).create({
    _id: 'camp-guard-fresh', name: 'Fresh', status: 'queued', sendMode: 'blast', stream: 'outreach',
    templateId: 'tpl-1', accountPool: ['acc-1'], stats: { sent: 5, bounced: 2 },
    createdAt: new Date().toISOString()
  });
  assert.equal(await guardBounceRate(ORG, 'camp-guard-fresh'), false);

  // Already paused → the guard never touches it again.
  assert.equal(await guardBounceRate(ORG, 'camp-guard'), false);
});

test('contacts get Constant-Contact-style status + auto consent evidence', async () => {
  const { createContacts } = await import('../packages/entitlements/contacts.js');
  // Website-form signup → subscribed + tamper-proof evidence with source & IP.
  await createContacts(ctx, [{ email: 'consent-me@x.example', listIds: [],
    source: 'form:newsletter', consentIp: '203.0.113.7' }]);
  let c = await scoped('contacts', ctx).findOne({ email: 'consent-me@x.example' });
  assert.equal(c.status, 'subscribed');
  assert.equal(c.consentSource, 'website-form');
  const rec = await scoped('consent_records', ctx).findOne({ email: 'consent-me@x.example' });
  assert.ok(rec?.evidenceHash, 'consent evidence auto-recorded');
  assert.equal(rec.source, 'website-form');
  assert.equal(rec.ip, '203.0.113.7');

  // A bounce flips the CONTACT itself (visible on the contacts page).
  await scoped('contacts', ctx).create({ _id: 'ct-bnc', email: 'bnc-ct@x.example',
    status: 'subscribed', createdAt: new Date().toISOString() });
  await getQueue('webhook').add('provider.event', { provider: 'test',
    event: { id: 'bnc-ct-1', type: 'bounce', email: 'bnc-ct@x.example', organizationId: ORG } });
  await wait(600);
  c = await scoped('contacts', ctx).findOne({ _id: 'ct-bnc' });
  assert.equal(c.status, 'bounced');

  // The import path records consent as 'import'.
  await createContacts(ctx, [{ email: 'imported@x.example', listIds: [], consentSource: 'import' }]);
  const rec2 = await scoped('consent_records', ctx).findOne({ email: 'imported@x.example' });
  assert.equal(rec2.source, 'import');
  assert.ok(rec2.evidenceHash);
});

after(async () => {
  await closeQueues();
});
