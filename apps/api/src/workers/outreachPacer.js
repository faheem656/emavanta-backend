import { scoped } from '../../../../packages/database/store.js';
import { registerWorker, getQueue } from '../../../../packages/queue/index.js';
import { nextSendAt, canSend, pacingFor } from '../../../../packages/email-engine/cadence.js';
import { rampCapForDay } from '../../../../packages/deliverability/index.js';
import { acquireStream } from '../../../../packages/rate-limiter/index.js';
import { deliverOne } from './campaignRunner.js';

/**
 * One self-rescheduling job per sending account (never one job per email).
 * Jitter + working hours + daily/weekly caps + warmup ramp + pause-on-reply.
 */
export const startOutreachPacer = () => registerWorker('outreach', async payload => {
  const { organizationId, campaignId, accountId, recipientIds = [], batchId } = payload;
  const ctx = { organizationId };
  const account = await scoped('sending_accounts', ctx).findOne({ _id: accountId });
  const campaign = await scoped('campaigns', ctx).findOne({ _id: campaignId });
  const template = campaign && await scoped('templates', ctx).findOne({ _id: campaign.templateId });
  if (!account || !campaign || !template) return;
  const defer=async delay=>getQueue('outreach').add('outreach.pacer',payload,
    {jobId:`pacer-${campaignId}-${accountId}-${batchId || 'adhoc'}`,replace:true,delay});
  // the campaign decides the pace; a job that carries its own policy (older events) wins
  const sendPolicy = pacingFor({ ...campaign, sendPolicy: payload.sendPolicy || campaign.sendPolicy });
  if (account.status !== 'active') { await defer(900000); return; } // preserve the remaining recipients
  if (!canSend(sendPolicy, account.sentToday)) { await defer(900000); return; }

  const warmDay = Math.max(1, Math.floor((Date.now() - Date.parse(account.createdAt || new Date().toISOString())) / 86400_000) + 1);
  const cap = Math.min(sendPolicy.dailyCap || 50, account.warmup ? rampCapForDay(account.warmupPlan, warmDay) : Infinity);
  if ((account.sentToday || 0) >= cap) { await defer(900000); return; }
  if ((account.sentWeek || 0) >= (sendPolicy.weeklyCap || 250)) { await defer(900000); return; }

  const [recipientId, ...rest] = recipientIds;
  if (recipientId) {
    if (sendPolicy.pauseOnReply !== false) {
      const pause = await scoped('sequence_pauses', ctx).findOne({ accountId, status: { $ne: 'resolved' } });
      if (pause) { await defer(900000); return; }
    }
    const limit = await acquireStream({ organizationId, stream: 'outreach', accountId,
      domain: String(account.fromEmail || '').split('@')[1] || 'unknown',
      streamCapacity: 60, streamRefill: 1, accountCapacity: 10, accountRefill: 0.2 });
    if (!limit.ok) {
      await getQueue('outreach').add('outreach.pacer', payload,
        { jobId: `pacer-${campaignId}-${accountId}-${batchId || 'adhoc'}`, replace: true, delay: Math.max(1000, (limit.retryAfter || 5) * 1000) });
      return;
    }
    await deliverOne({ organizationId, campaignId, recipientId, account, template, campaign });
  }

  if (rest.length) {
    const policy = { ...sendPolicy, minDelaySec: sendPolicy.minDelaySec || 45, maxDelaySec: sendPolicy.maxDelaySec || 90 };
    const delay = nextSendAt(policy, new Date()).getTime() - Date.now();
    await getQueue('outreach').add('outreach.pacer', { ...payload, recipientIds: rest },
      { jobId: `pacer-${campaignId}-${accountId}-${batchId || 'adhoc'}`, replace: true, delay: Math.max(0, delay) });
  } else if (batchId) {
    // Batch fully walked: close it so progress and the batch counter stay truthful.
    await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
      { $set: { status: 'done', completedAt: new Date().toISOString() } });
  }
});
