import { expireCryptoAddons, expireCryptoSubscription } from '../payments/crypto-service.js';
import { isMemoryMode } from '../../../../packages/database/store.js';
import { collection, scoped } from '../../../../packages/database/store.js';
import { getQueue, hasPendingJob } from '../../../../packages/queue/index.js';
import { sweepStripe } from '../payments/stripe-service.js';
import { publishAutomationTriggerEvents } from '../../../../packages/automations/triggers.js';
import { enqueueAutomationStep } from '../../../../packages/automations/jobs.js';
import { fanoutBlastBatches, completeFinishedCampaigns } from './campaignRunner.js';
import { launchDueCampaigns } from '../services/campaignLaunch.js';
import { pacingFor } from '../../../../packages/email-engine/cadence.js';
import { cooldownUntil } from '../../../../packages/deliverability/index.js';

/** UTC calendar day / ISO week — the keys the daily and weekly caps reset on. */
const dayKey = () => new Date().toISOString().slice(0, 10);
const weekKey = date => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

/**
 * sentToday / sentWeek are what the daily and weekly campaign caps compare
 * against. Without this reset the "daily" limit was a lifetime limit: after the
 * first day every mailbox looked exhausted and the pacer waited forever.
 * Idempotent — the resetAt key makes a re-run in the same day a no-op.
 */
export async function resetDailySendCounters() {
  const today = dayKey();
  const thisWeek = weekKey(new Date());
  const accounts = collection('sending_accounts');
  await accounts.updateMany(
    { $or: [{ sentTodayResetAt: { $ne: today } }, { sentTodayResetAt: { $exists: false } }] },
    { $set: { sentToday: 0, sentTodayResetAt: today } });
  await accounts.updateMany(
    { $or: [{ sentWeekResetAt: { $ne: thisWeek } }, { sentWeekResetAt: { $exists: false } }] },
    { $set: { sentWeek: 0, sentWeekResetAt: thisWeek } });
}

/**
 * A queued campaign whose pacer died (failed job, crash, deploy) would stall
 * forever — nothing else re-arms it. Revive it only when no pacer job is
 * pending, so a healthy delayed pacer keeps its human gap.
 */
export async function reviveStalledPacers() {
  const campaigns = await collection('campaigns').find({ status: 'queued' }, { limit: 100 });
  let revived = 0;
  for (const campaign of campaigns) {
    const ctx = { organizationId: campaign.organizationId };
    if (campaign.sendMode === 'blast') {
      // Blast campaigns revive as batch jobs (fanout skips already-pending ones).
      revived += await fanoutBlastBatches({ organizationId: campaign.organizationId, campaign });
      continue;
    }
    if (await hasPendingJob('outreach', `pacer-${campaign._id}`)) continue;
    const unfinished = await scoped('campaign_batches', ctx)
      .findOne({ campaignId: campaign._id, status: { $ne: 'done' } });
    const loose = unfinished ? true
      : !!(campaign.intake?.status === 'running'
        || await scoped('campaign_recipients', ctx).findOne({ campaignId: campaign._id, status: 'queued' }));
    if (!loose) continue;
    await getQueue('outreach').add('outreach.pacer', {
      organizationId: campaign.organizationId, campaignId: campaign._id,
      accountPool: campaign.accountPool || [], rotation: campaign.rotation,
      stream: campaign.stream, sendPolicy: campaign.sendPolicy || pacingFor(campaign)
    }, { jobId: `pacer-${campaign._id}`, replace: true });
    revived += 1;
  }
  return revived;
}

/** Cool-downs expire: flip limited mailboxes back to `active` exactly when their window ends. */
export async function healExpiredMailboxes() {
  const accounts = await collection('sending_accounts').find({ status: 'limited' }, { limit: 100 });
  let healed = 0;
  for (const account of accounts) {
    let until = account.limitedUntil ? Date.parse(account.limitedUntil) : NaN;
    if (!Number.isFinite(until)) {
      // Cool-downs saved before limitedUntil existed (or by older builds): read the
      // provider's own deadline out of lastError, else one hour from when the
      // account was last touched — either way it resumes by itself eventually.
      const from = Date.parse(account.updatedAt || account.createdAt || '') || Date.now();
      until = Date.parse(cooldownUntil(account.lastError || '', from));
    }
    if (Number.isFinite(until) && until <= Date.now()) {
      await collection('sending_accounts').updateOne({ _id: account._id },
        { $set: { status: 'active', limitedUntil: null } });
      healed += 1;
    }
  }
  return healed;
}

// A periodic sweep supplies the long-horizon poller after restarts. Claims expire
// so a crash between claiming and queueing does not strand scheduled rows forever.
export async function sweepScheduledJobs() {
  const now=new Date().toISOString();
  await resetDailySendCounters().catch(()=>{});
  await reviveStalledPacers().catch(()=>{});
  await healExpiredMailboxes().catch(()=>{});
  // Scheduled campaigns: fire everything whose startAt has passed.
  await launchDueCampaigns().catch(e=>console.error('[scheduler] scheduled campaign launch failed',String(e?.message||e)));
  // Safety net: finish any campaign whose batches and intake are done (blast
  // has no pacer, so without this a finished blast could stay "queued").
  await completeFinishedCampaigns().catch(e=>console.error('[scheduler] completion sweep failed',String(e?.message||e)));
  if(!isMemoryMode()){
    const due=await collection('crypto_addon_grants').find({status:'active',expiresAt:{$lte:new Date().toISOString()}},{limit:200});
    for(const id of new Set(due.map(x=>x.organizationId).filter(Boolean)))await expireCryptoAddons(id);
    const expiredPlans=await collection('organizations').find({planChangeSource:{$in:['crypto','stripe','platform_manual_override']},planExpiresAt:{$lte:new Date().toISOString(),$ne:null}},{limit:200});
    for(const org of expiredPlans) await expireCryptoSubscription(org._id);
  }
  const pendingEvents=await collection('outbox_events').find({status:'pending'},{limit:500});
  for(const event of pendingEvents) await getQueue('outbox').add('outbox.publish',{eventId:event._id},{jobId:`outbox-${event._id}`,retryFailed:true});
  // Recover trigger events whose worker died after claiming them. finishTrigger
  // is idempotent and uses the stable enrollment ID, so retry is safe.
  await collection('automation_trigger_events').updateMany({status:'processing',leaseUntil:{$lte:now}},{$set:{status:'pending',leaseUntil:null,updatedAt:now}});
  const automationEvents=await collection('automation_trigger_events').find({status:'pending'},{limit:500});
  if(automationEvents.length)await publishAutomationTriggerEvents(automationEvents.map(event=>event._id));
  const runningEnrollments=await collection('sequence_enrollments').find({status:{$in:['queued','waiting','running']}},{limit:500});
  for(const enrollment of runningEnrollments){
    const flow=await collection('sequences').findOne({_id:enrollment.sequenceId,organizationId:enrollment.organizationId,status:'active',executionEnabled:true,deleted:{$ne:true}});
    if(flow)await enqueueAutomationStep({organizationId:enrollment.organizationId,sequenceId:enrollment.sequenceId,
      enrollmentId:enrollment._id,stepIndex:enrollment.currentStep||0,runAt:enrollment.nextRunAt||now});
  }
  const jobs=collection('scheduled_jobs');
  await jobs.updateMany({status:'claimed',leaseUntil:{$lte:now}},{$set:{status:'pending'}});
  const due=await jobs.find({status:'pending',runAt:{$lte:now}},{limit:500});
  for(const organizationId of new Set(due.map(row=>row.organizationId).filter(Boolean))) {
    await getQueue('scheduler').add('scheduler.poll',{organizationId,poll:true},{jobId:`poll-${organizationId}`,dedupe:false});
  }
  return due.length;
}
export function startSchedulerSweep(){
  let stopped=false, schedulerBusy=false, stripeBusy=false;
  const runScheduler=async()=>{if(stopped||schedulerBusy)return;schedulerBusy=true;try{await sweepScheduledJobs();}catch(e){console.error('[scheduler] sweep failed',String(e?.code||'SCHEDULER_ERROR'));}finally{schedulerBusy=false;}};
  const runStripe=async()=>{if(stopped||stripeBusy)return;stripeBusy=true;try{await sweepStripe();}catch(e){console.error('[payments] sweep unavailable',String(e?.code||'PAYMENT_ERROR'));}finally{stripeBusy=false;}};
  const schedulerTimer=setInterval(runScheduler,30000), stripeTimer=setInterval(runStripe,30000);
  schedulerTimer.unref?.();stripeTimer.unref?.();void runScheduler();void runStripe();
  return async()=>{stopped=true;clearInterval(schedulerTimer);clearInterval(stripeTimer);while(schedulerBusy||stripeBusy)await new Promise(r=>setTimeout(r,20));};
}
