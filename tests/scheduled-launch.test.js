/**
 * Scheduled launch (Send now vs Schedule):
 *  - scheduleLaunch arms a future start without sending anything,
 *  - launchDueCampaigns fires it once startAt passes (the sweep's job),
 *  - cancelSchedule returns the campaign to draft,
 *  - past/invalid times are rejected at arm time.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.MONGODB_URI; // in-memory store

const { collection, scoped } = await import('../packages/database/store.js');
const { closeQueues, hasPendingJob } = await import('../packages/queue/index.js');
const { scheduleLaunch, cancelSchedule, launchDueCampaigns } =
  await import('../apps/api/src/services/campaignLaunch.js');

const ORG = 'org-sched';
const ctx = { organizationId: ORG };
after(async () => { await closeQueues(); });

test('schedule → due → sweep launches; cancel returns to draft', async () => {
  await collection('organizations').create({ _id: ORG, name: 'Sched', plan: 'growth' });
  await scoped('sending_accounts', ctx).create({
    _id: 'acc-s', fromEmail: 's@x.test', fromName: 'S', status: 'active',
    authMethod: 'mock', stream: 'outreach', warmup: false, createdAt: new Date().toISOString()
  });
  await scoped('templates', ctx).create({ _id: 'tpl-s', name: 'T', subject: 'Hi', mode: 'code', html: '<p>Hi</p>', version: 1 });
  await scoped('contacts', ctx).create({ _id: 'c-s1', email: 'a@x.test', status: 'subscribed', listIds: ['list-s'] });
  await scoped('campaigns', ctx).create({
    _id: 'camp-arm', status: 'draft', sendMode: 'blast', stream: 'outreach',
    templateId: 'tpl-s', accountPool: ['acc-s'], rotation: 'round_robin', listIds: ['list-s'],
    sendPolicy: { minDelaySec: 10, maxDelaySec: 15, jitterPct: 0, dailyCap: 5000, weeklyCap: 35000,
      timezone: 'UTC', schedule: { startTime: '00:00', endTime: '24:00', daysOfWeek: [1, 2, 3, 4, 5, 6, 7] } },
    createdAt: new Date().toISOString()
  });

  // Arm one hour ahead — nothing may send yet.
  let c = await scoped('campaigns', ctx).findOne({ _id: 'camp-arm' });
  const armed = await scheduleLaunch(ctx, c, new Date(Date.now() + 3600_000).toISOString());
  assert.equal(armed.status, 'scheduled');
  c = await scoped('campaigns', ctx).findOne({ _id: 'camp-arm' });
  assert.equal(c.status, 'scheduled');
  assert.ok(Date.parse(c.startAt) > Date.now());
  assert.equal(await launchDueCampaigns(), 0, 'a future campaign must not fire');

  // Cancel → back to draft, startAt gone.
  const cancelled = await cancelSchedule(ctx, c);
  assert.equal(cancelled.status, 'draft');
  c = await scoped('campaigns', ctx).findOne({ _id: 'camp-arm' });
  assert.equal(c.status, 'draft');
  assert.ok(!c.startAt);

  // Arm with a past startAt (as if the clock reached it) → the sweep fires it.
  await scoped('campaigns', ctx).updateOne({ _id: 'camp-arm' },
    { $set: { status: 'scheduled', startAt: new Date(Date.now() - 1000).toISOString() } });
  const fired = await launchDueCampaigns();
  assert.equal(fired, 1);
  c = await scoped('campaigns', ctx).findOne({ _id: 'camp-arm' });
  assert.equal(c.status, 'queued', 'due campaign is fully launched');
  assert.ok(!c.startAt, 'startAt is cleared once it launches');
  assert.equal(c.intake?.total, 1);
  assert.ok(await hasPendingJob('campaign_intake', 'intake-camp-arm-0'), 'first intake chunk queued');
});

test('schedule rejects past times', async () => {
  const c = await scoped('campaigns', ctx).findOne({ _id: 'camp-arm' });
  await assert.rejects(() => scheduleLaunch(ctx, c, new Date(Date.now() - 60_000).toISOString()),
    /future/i);
});

test('blast sendPolicy accepts endTime 24:00 but stays strict HH:mm', async () => {
  const { campaignSchema, campaignPacingSchema } = await import('../packages/validation/index.js');
  const blastPolicy = {
    minDelaySec: 10, maxDelaySec: 15, jitterPct: 0, dailyCap: 5000, weeklyCap: 35000,
    pauseOnReply: false, timezone: 'UTC',
    schedule: { startTime: '00:00', endTime: '24:00', daysOfWeek: [1, 2, 3, 4, 5, 6, 7] },
    activeHours: { start: 0, end: 24 }, weekend: true
  };
  // The wizard's blast payload — this exact shape used to fail validation with
  // "sendPolicy.schedule.endTime — endTime must use HH:mm".
  assert.doesNotThrow(() => campaignSchema.parse({
    name: 'Blast', stream: 'outreach', listIds: ['l'], accountPool: ['a'], templateId: 't',
    sendMode: 'blast', sendPolicy: blastPolicy
  }));
  assert.doesNotThrow(() => campaignPacingSchema.parse({ sendMode: 'blast', sendPolicy: { schedule: blastPolicy.schedule } }));
  // …but everything else stays strict.
  assert.throws(() => campaignSchema.parse({
    name: 'Blast', stream: 'outreach', listIds: ['l'], accountPool: ['a'], templateId: 't',
    sendMode: 'blast', sendPolicy: { ...blastPolicy, schedule: { startTime: '00:00', endTime: '24:30', daysOfWeek: [1] } }
  }), /endTime must use HH:mm/);
  assert.throws(() => campaignSchema.parse({
    name: 'Blast', stream: 'outreach', listIds: ['l'], accountPool: ['a'], templateId: 't',
    sendMode: 'blast', sendPolicy: { ...blastPolicy, schedule: { startTime: '00:00', endTime: '9:00', daysOfWeek: [1] } }
  }), /endTime must use HH:mm/);
});

// ─────────────────────────────────────────────────────────────
// Completion (blast campaigns used to stay "queued" forever — the
// pacer that flips a campaign to completed only runs in human mode).
// ─────────────────────────────────────────────────────────────
test('completeFinishedCampaigns flips finished blasts to completed, leaves open ones alone',async()=>{
  const { completeFinishedCampaigns } = await import('../apps/api/src/workers/campaignRunner.js');
  const suffix=Date.now();
  let n=0;
  const mkCampaign=async({intakeStatus='done',batchStatus='done',recipientStatus='skipped'}={})=>{
    const orgId=`org-campaign-${suffix}-${n++}`;
    const campaignId=`campaign-${suffix}-${n}`;
    const ctx={organizationId:orgId};
    await scoped('campaigns',ctx).create({_id:campaignId,status:'queued',intake:{status:intakeStatus}});
    await scoped('campaign_batches',ctx).create({campaignId,batchIndex:0,status:batchStatus});
    await scoped('campaign_recipients',ctx).create({campaignId,email:'lead@example.com',status:recipientStatus});
    return {orgId,campaignId,ctx};
  };
  const statusOf=async row=>(await scoped('campaigns',row.ctx).findOne({_id:row.campaignId})).status;

  // finished (intake done + batch done + nobody queued) → completed
  const done=await mkCampaign();
  assert.equal(await completeFinishedCampaigns({campaignId:done.campaignId}),1);
  assert.equal(await statusOf(done),'completed');

  // audience still copying → untouched
  const running=await mkCampaign({intakeStatus:'running'});
  await completeFinishedCampaigns({campaignId:running.campaignId});
  assert.equal(await statusOf(running),'queued');

  // open batch → untouched
  const openBatch=await mkCampaign({batchStatus:'sending'});
  await completeFinishedCampaigns({campaignId:openBatch.campaignId});
  assert.equal(await statusOf(openBatch),'queued');

  // recipient still queued (deferred/paced) → untouched
  const stillQueued=await mkCampaign({recipientStatus:'queued'});
  await completeFinishedCampaigns({campaignId:stillQueued.campaignId});
  assert.equal(await statusOf(stillQueued),'queued');
});

// ─────────────────────────────────────────────────────────────
// Sender pool validation must name every offending mailbox and must NOT
// block on `limited` (auto bounce-cooldown with a scheduled resume).
// ─────────────────────────────────────────────────────────────
test('selectedSenderPool reports each bad mailbox by name and allows cooling-down ones',async()=>{
  const { selectedSenderPool } = await import('../apps/api/src/services/campaignLaunch.js');
  const orgId=`org-senderpool-${Date.now()}`;
  const ctx={organizationId:orgId,user:{id:'u1',role:'owner'}};
  await scoped('sending_accounts',ctx).create({_id:'acc-ok',fromEmail:'ok@x.test',status:'active',stream:'outreach'});
  await scoped('sending_accounts',ctx).create({_id:'acc-err',fromEmail:'bad@x.test',status:'error',lastError:'Auth failed',stream:'outreach'});
  await scoped('sending_accounts',ctx).create({_id:'acc-lim',fromEmail:'cool@x.test',status:'limited',limitedUntil:new Date(Date.now()+3600e3).toISOString(),stream:'outreach'});
  await scoped('sending_accounts',ctx).create({_id:'acc-pend',fromEmail:'new@x.test',status:'pending_verification',stream:'outreach'});

  await assert.rejects(()=>selectedSenderPool(ctx,{accountPool:['acc-ok','acc-err','acc-pend'],stream:'outreach'}),e=>{
    assert.match(e.message,/bad@x\.test: failed — Auth failed/);
    assert.match(e.message,/new@x\.test: pending verification/);
    assert.ok(!/ok@x\.test/.test(e.message),'healthy mailbox must not be named');
    return true;
  });

  // limited (auto cooldown) + active → allowed
  const ok=await selectedSenderPool(ctx,{accountPool:['acc-ok','acc-lim'],stream:'outreach'});
  assert.equal(ok.length,2);
});
