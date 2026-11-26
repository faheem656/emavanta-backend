/**
 * E2E sanity for blast restore + provider cool-down auto stop/resume.
 * Run from the backend dir: node e2e-blast-check.mjs
 */
process.env.NODE_ENV = 'test';
delete process.env.MONGODB_URI;

const { collection, scoped } = await import('./packages/database/store.js');
const { getQueue, closeQueues, hasPendingJob } = await import('./packages/queue/index.js');
const { fanoutBlastBatches } = await import('./apps/api/src/workers/campaignRunner.js');
const { healExpiredMailboxes } = await import('./apps/api/src/workers/schedulerSweep.js');
const { startWebhookProcessor } = await import('./apps/api/src/workers/webhookProcessor.js');
const { eligibleAccounts } = await import('./packages/email-engine/selection.js');
const { cooldownUntil, BOUNCE_AUTO_LIMIT } = await import('./packages/deliverability/index.js');

const ORG = 'org-e2e';
const ctx = { organizationId: ORG };
const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

// ── seed ─────────────────────────────────────────────────────────────────────
await collection('organizations').create({ _id: ORG, name: 'E2E', plan: 'growth' });
await scoped('sending_accounts', ctx).create({
  _id: 'acc-e2e', fromEmail: 'info@mse.email', fromName: 'Info', status: 'active',
  authMethod: 'mock', stream: 'outreach', sentToday: 0, sentWeek: 0, warmup: false,
  createdAt: new Date().toISOString()
});
await scoped('templates', ctx).create({
  _id: 'tpl-e2e', name: 'T', subject: 'Hello', mode: 'code', html: '<p>Hi</p>', version: 1
});
await scoped('templates', ctx).create({
  _id: 'tpl-personal', name: 'P', subject: 'Hi {{first_name}}', mode: 'code', html: '<p>Hello {{first_name}} from {{company}}</p>', version: 1
});
await scoped('campaigns', ctx).create({
  _id: 'camp-blast', name: 'Blast', status: 'queued', sendMode: 'blast',
  stream: 'outreach', templateId: 'tpl-e2e', accountPool: ['acc-e2e'], rotation: 'round_robin',
  sendPolicy: { dailyCap: 5000, weeklyCap: 35000, minDelaySec: 10, maxDelaySec: 15, jitterPct: 0, pauseOnReply: false },
  createdAt: new Date().toISOString()
});
// batch 1 done, batch 2 pending with two recipients
await scoped('campaign_batches', ctx).create({ _id: 'b1', campaignId: 'camp-blast', index: 0, status: 'done', recipientIds: ['r1'] });
await scoped('campaign_batches', ctx).create({ _id: 'b2', campaignId: 'camp-blast', index: 1, status: 'queued', recipientIds: ['r2', 'r3'] });
// recipients must be queued for runBatch to walk them
for (const id of ['r2', 'r3']) {
  await scoped('campaign_recipients', ctx).create({ _id: id, campaignId: 'camp-blast', contactId: id, email: `${id}@x.example`, status: 'queued' });
}
await scoped('messages', ctx).create({ id: 'msg-1', organizationId: ORG, campaignId: 'camp-blast', sendingAccountId: 'acc-e2e', to: 'r1@x.example' });

// ── 1. blast fanout hands only unfinished batches to the fast path ───────────
startWebhookProcessor();
const handed = await fanoutBlastBatches({ organizationId: ORG, campaign: await scoped('campaigns', ctx).findOne({ _id: 'camp-blast' }) });
check('fanout queues only unfinished batches', handed === 1, `queued=${handed}`);
check('batch job is pending', await hasPendingJob('campaign', 'batch-b2') === true);
const again = await fanoutBlastBatches({ organizationId: ORG, campaign: await scoped('campaigns', ctx).findOne({ _id: 'camp-blast' }) });
check('fanout never double-queues a pending batch', again === 0, `queued=${again}`);

// ── 2. five bounces auto-cool the mailbox (mirror of provider limit) ─────────
for (let i = 0; i < BOUNCE_AUTO_LIMIT; i++) {
  await getQueue('webhook').add('provider.event', {
    provider: 'test',
    event: { id: `bnc-${i}`, type: 'bounce', email: `bnc${i}@x.example`, messageId: 'msg-1' }
  });
}
await wait(600);
const cooled = await scoped('sending_accounts', ctx).findOne({ _id: 'acc-e2e' });
check('5 bounces flip the mailbox to limited', cooled.status === 'limited', `status=${cooled.status}`);
check('limited carries a resume deadline', Number.isFinite(Date.parse(cooled.limitedUntil || '')), `until=${cooled.limitedUntil}`);
check('bounce ledger counted every bounce', cooled.bounceWindow?.count === BOUNCE_AUTO_LIMIT, `count=${cooled.bounceWindow?.count}`);

// ── 3. a live cool-down holds the mailbox back, an expired one does not ──────
const now = new Date('2026-11-25T20:00:00Z');
check('live cool-down excludes the mailbox',
  eligibleAccounts([{ ...cooled, limitedUntil: '2026-11-25T21:00:00.000Z' }], { stream: 'outreach', now }).length === 0);
check('expired cool-down is usable again',
  eligibleAccounts([{ ...cooled, limitedUntil: '2026-11-25T19:00:00.000Z' }], { stream: 'outreach', now }).length === 1);

// ── 4. sweep heals it the moment the window ends ─────────────────────────────
await scoped('sending_accounts', ctx).updateOne({ _id: 'acc-e2e' }, { $set: { limitedUntil: new Date(Date.now() - 1000).toISOString() } });
const healed = await healExpiredMailboxes();
const back = await scoped('sending_accounts', ctx).findOne({ _id: 'acc-e2e' });
check('sweep flips expired cool-down back to active', healed === 1 && back.status === 'active', `healed=${healed} status=${back.status}`);

// ── 4b. legacy limited mailbox (no limitedUntil) heals from its lastError ────
await scoped('sending_accounts', ctx).create({
  _id: 'acc-legacy', fromEmail: 'old@x.example', fromName: 'Old', status: 'limited',
  authMethod: 'mock', stream: 'outreach', warmup: false,
  lastError: "550 5.4.6 will not be allowed to send emails till [time=2026-11-20 10:00:00 UTC]",
  updatedAt: '2026-11-20T09:00:00.000Z', createdAt: '2026-11-20T09:00:00.000Z'
});
const legacyHealed = await healExpiredMailboxes();
const legacy = await scoped('sending_accounts', ctx).findOne({ _id: 'acc-legacy' });
check('legacy limited mailbox (provider window already passed) heals itself',
  legacyHealed >= 1 && legacy.status === 'active', `status=${legacy.status}`);

// ── 5. provider deadline parsing ─────────────────────────────────────────────
const providerError = "550 5.4.6 Sender Hourly Bounce Limit Exceeded - will not be allowed to send emails till [time=2026-11-25 23:36:48 UTC] as hourly bounce limit is exceeded";
check('provider deadline parsed exactly',
  cooldownUntil(providerError, Date.parse('2026-11-25T20:00:00Z')) === '2026-11-25T23:36:48.000Z');
check('unknown errors default to a 1-hour cool-down',
  cooldownUntil('SMTP 421 temp failed', Date.parse('2026-11-25T20:00:00Z')) === '2026-11-25T21:00:00.000Z');

// ── 6. failure classification drives stop/resume behaviour ───────────────────
const { classifySendError } = await import('./packages/deliverability/index.js');
check('535 login failure → auth (recipient stays queued, reconnect needed)',
  classifySendError(new Error('Invalid login: 535 5.7.8 Error: authentication failed')) === 'auth');
check('hourly bounce limit → account cool-down (not a recipient bounce)',
  classifySendError(new Error('550 5.4.6 Sender Hourly Bounce Limit Exceeded')) === 'account');
check('550 recipient rejection → definite bounce',
  classifySendError(new Error('550 5.5.1 Recipient rejected - OXSEU001_403')) === 'rejected');
check('timeout → ambiguous (manual review)',
  classifySendError(new Error('connect ETIMEDOUT')) === 'unknown');

// ── 7. bounce-rate circuit breaker pauses a dangerous campaign ───────────────
const { guardBounceRate } = await import('./apps/api/src/workers/campaignRunner.js');
await scoped('campaigns', ctx).create({
  _id: 'camp-guard', name: 'Guard', status: 'queued', sendMode: 'blast', stream: 'outreach',
  templateId: 'tpl-e2e', accountPool: ['acc-e2e'], stats: { sent: 30, bounced: 2 },
  createdAt: new Date().toISOString()
});
check('2/30 = 6.7% bounce rate pauses the campaign',
  await guardBounceRate(ORG, 'camp-guard') === true);
const guarded = await scoped('campaigns', ctx).findOne({ _id: 'camp-guard' });
check('paused with a review reason',
  guarded.status === 'paused' && guarded.pauseReason === 'high_bounce_rate',
  `reason=${guarded.pauseReason} detail=${guarded.pauseDetail}`);

// ── 8. the runner never touches a suppressed (paused) recipient ──────────────
const { startCampaignRunner } = await import('./apps/api/src/workers/campaignRunner.js');
startCampaignRunner();
await scoped('contacts', ctx).create({ _id: 'cs-1', email: 'bounced@x.example', status: 'bounced', listIds: [] });
await scoped('contacts', ctx).create({ _id: 'cs-2', email: 'clean@x.example', status: 'subscribed', listIds: [], firstName: 'Clea', company: 'Northwind' });
await scoped('campaigns', ctx).create({
  _id: 'camp-supp', status: 'queued', sendMode: 'blast', stream: 'outreach',
  templateId: 'tpl-personal', accountPool: ['acc-e2e'], rotation: 'round_robin',
  sendPolicy: { dailyCap: 5000, weeklyCap: 35000, minDelaySec: 10, maxDelaySec: 15, jitterPct: 0, pauseOnReply: false,
    timezone: 'UTC', schedule: { startTime: '00:00', endTime: '24:00', daysOfWeek: [1, 2, 3, 4, 5, 6, 7] } },
  createdAt: new Date().toISOString()
});
await scoped('campaign_batches', ctx).create({ _id: 'b-supp', campaignId: 'camp-supp', index: 0, status: 'queued', checkpoint: 0, total: 2, recipientIds: ['rs-1', 'rs-2'] });
await scoped('campaign_recipients', ctx).create({ _id: 'rs-1', campaignId: 'camp-supp', contactId: 'cs-1', email: 'bounced@x.example', status: 'paused', reason: 'already_bounced' });
await scoped('campaign_recipients', ctx).create({ _id: 'rs-2', campaignId: 'camp-supp', contactId: 'cs-2', email: 'clean@x.example', status: 'queued' });
await getQueue('campaign').add('campaign.batch',
  { organizationId: ORG, campaignId: 'camp-supp', batchId: 'b-supp', recipientIds: ['rs-1', 'rs-2'], accountPool: ['acc-e2e'], rotation: 'round_robin', stream: 'outreach', sendMode: 'blast' },
  { jobId: 'e2e-supp-batch' });
await wait(900);
const supp1 = await scoped('campaign_recipients', ctx).findOne({ _id: 'rs-1' });
const supp2 = await scoped('campaign_recipients', ctx).findOne({ _id: 'rs-2' });
const suppBatch = await scoped('campaign_batches', ctx).findOne({ _id: 'b-supp' });
check('suppressed lead stays paused (never sent)', supp1.status === 'paused' && supp1.reason === 'already_bounced', `status=${supp1.status} reason=${supp1.reason}`);
check('clean lead in the same batch is sent', supp2.status === 'sent', `status=${supp2.status} error=${supp2.error || '-'} attempts=${supp2.attempts || 0} acc=${(await scoped('sending_accounts', ctx).findOne({ _id: 'acc-e2e' }))?.status}`);
check('batch completes with the skipped row counted', suppBatch.status === 'done', `status=${suppBatch.status}`);
// The sent message must carry the CONTACT's real name — not the registry default.
const personalized = await scoped('messages', ctx).findOne({ campaignId: 'camp-supp', to: 'clean@x.example' });
check('sent email is personalized from the contact record',
  personalized?.subject === 'Hi Clea', `subject=${personalized?.subject}`);

// ── 9. scheduled campaigns: arm → sweep fires → queued; cancel reverts ──────
const { scheduleLaunch, cancelSchedule, launchDueCampaigns } = await import('./apps/api/src/services/campaignLaunch.js');
await scoped('contacts', ctx).create({ _id: 'c-arm', email: 'arm@x.example', status: 'subscribed', listIds: ['list-arm'] });
await scoped('campaigns', ctx).create({
  _id: 'camp-arm', status: 'draft', sendMode: 'blast', stream: 'outreach',
  templateId: 'tpl-e2e', accountPool: ['acc-e2e'], rotation: 'round_robin', listIds: ['list-arm'],
  sendPolicy: { dailyCap: 5000, weeklyCap: 35000, minDelaySec: 10, maxDelaySec: 15, jitterPct: 0, pauseOnReply: false,
    timezone: 'UTC', schedule: { startTime: '00:00', endTime: '24:00', daysOfWeek: [1, 2, 3, 4, 5, 6, 7] } },
  createdAt: new Date().toISOString()
});
const armCtx = { organizationId: ORG };
let armRow = await scoped('campaigns', ctx).findOne({ _id: 'camp-arm' });
const armed = await scheduleLaunch(armCtx, armRow, new Date(Date.now() + 3600_000).toISOString());
check('schedule arms a future campaign without sending', armed.status === 'scheduled', `status=${armed.status}`);
check('sweep leaves future campaigns alone', await launchDueCampaigns() === 0);
armRow = await scoped('campaigns', ctx).findOne({ _id: 'camp-arm' });
const cancelled = await cancelSchedule(armCtx, armRow);
check('cancel schedule returns the campaign to draft', cancelled.status === 'draft', `status=${cancelled.status}`);
await scoped('campaigns', ctx).updateOne({ _id: 'camp-arm' },
  { $set: { status: 'scheduled', startAt: new Date(Date.now() - 1000).toISOString() } });
check('sweep fires a due campaign', await launchDueCampaigns() === 1);
armRow = await scoped('campaigns', ctx).findOne({ _id: 'camp-arm' });
check('due campaign is queued with startAt cleared',
  armRow.status === 'queued' && !armRow.startAt, `status=${armRow.status} startAt=${armRow.startAt}`);

await closeQueues();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
