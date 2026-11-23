import { scoped } from '../../../../packages/database/store.js';
import { registerWorker, getQueue } from '../../../../packages/queue/index.js';
import { nextSendAt, canSend, isWithinWindow, pacingFor } from '../../../../packages/email-engine/cadence.js';
import { eligibleAccounts, selectAccount } from '../../../../packages/email-engine/selection.js';
import { rampCapForDay } from '../../../../packages/deliverability/index.js';
import { acquireStream } from '../../../../packages/rate-limiter/index.js';
import { deliverOne } from './campaignRunner.js';

const jobIdFor = ({ campaignId, batchId, accountId, legacyFixedAccount }) =>
  `pacer-${campaignId}-${legacyFixedAccount && accountId ? `${accountId}-` : ''}${batchId || 'adhoc'}`;

/**
 * One rescheduling job walks a small batch, choosing a mailbox from the campaign's
 * tenant-scoped sender pool for each recipient. Older jobs that contain only accountId
 * remain fixed to that mailbox so deployments can drain already-enqueued work safely.
 */
export const startOutreachPacer = () => registerWorker('outreach', async payload => {
  const { organizationId, campaignId, batchId, recipientIds = [] } = payload;
  const ctx = { organizationId };
  const [campaign, batch] = await Promise.all([
    scoped('campaigns', ctx).findOne({ _id: campaignId }),
    batchId ? scoped('campaign_batches', ctx).findOne({ _id: batchId }) : Promise.resolve(null)
  ]);
  if (!campaign || (batchId && !batch)) return;
  if (batch?.status === 'done' || campaign.status === 'paused') return;

  const template = await scoped('templates', ctx).findOne({ _id: campaign.templateId });
  if (!template) return;

  const legacyFixedAccount = !!payload.accountId && !Array.isArray(payload.accountPool);
  const accountPool = legacyFixedAccount
    ? [payload.accountId]
    : (Array.isArray(payload.accountPool) && payload.accountPool.length
      ? payload.accountPool
      : (campaign.accountPool || []));
  const uniquePool = [...new Set(accountPool)];
  const accounts = uniquePool.length
    ? await scoped('sending_accounts', ctx).find({ _id: { $in: uniquePool } })
    : [];
  const stream = payload.stream || campaign.stream || 'outreach';
  const sendPolicy = pacingFor({ ...campaign, sendPolicy: payload.sendPolicy || campaign.sendPolicy });
  const pacerJobId = jobIdFor({ campaignId, batchId, accountId: payload.accountId, legacyFixedAccount });
  const defer = async (delay, nextPayload = payload) => getQueue('outreach').add('outreach.pacer', nextPayload,
    { jobId: pacerJobId, replace: true, delay: Math.max(1000, delay) });

  const now = new Date();
  if (!isWithinWindow(sendPolicy, now)) {
    await defer(nextSendAt(sendPolicy, now).getTime() - now.getTime());
    return;
  }

  const warmupCapFor = account => {
    const warmDay = Math.max(1, Math.floor((Date.now() - Date.parse(account.createdAt || new Date().toISOString())) / 86400_000) + 1);
    return Math.min(sendPolicy.dailyCap || 50, account.warmup ? rampCapForDay(account.warmupPlan, warmDay) : Infinity);
  };
  const candidates = eligibleAccounts(accounts, { stream, now })
    .filter(account => canSend(sendPolicy, account.sentToday)
      && (account.sentToday || 0) < warmupCapFor(account)
      && (account.sentWeek || 0) < (sendPolicy.weeklyCap || 250));
  if (!candidates.length) {
    // Keep the recipients in the job. They can continue after a mailbox is reactivated
    // or a cap resets; never silently mark a blocked batch complete.
    await defer(900000);
    return;
  }

  let sendableAccounts = candidates;
  if (sendPolicy.pauseOnReply !== false) {
    const pauses = await scoped('sequence_pauses', ctx).find({ status: { $ne: 'resolved' }, accountId: { $in: candidates.map(a => a._id) } });
    const pausedIds = new Set(pauses.map(pause => pause.accountId));
    sendableAccounts = candidates.filter(account => !pausedIds.has(account._id));
    if (!sendableAccounts.length) { await defer(900000); return; }
  }

  const [recipientId, ...rest] = recipientIds;
  if (!recipientId) {
    if (batchId) await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
      { $set: { status: 'done', completedAt: new Date().toISOString() } });
    return;
  }

  const recipient = await scoped('campaign_recipients', ctx).findOne({ _id: recipientId });
  const state = payload.selectionState || { cursor: Number(batch?.index) || 0 };
  if (!recipient || recipient.status !== 'queued') {
    if (rest.length) {
      const delay = nextSendAt(sendPolicy, new Date()).getTime() - Date.now();
      await defer(delay, { ...payload, recipientIds: rest, selectionState: state });
    } else if (batchId) {
      await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
        { $set: { status: 'done', completedAt: new Date().toISOString() } });
    }
    return;
  }

  const { account, state: nextState } = selectAccount({ accounts: sendableAccounts,
    strategy: payload.rotation || campaign.rotation || 'round_robin',
    contactId: recipient.contactId || recipientId, state, stream, now });
  if (!account) { await defer(900000); return; }

  const limit = await acquireStream({ organizationId, stream, accountId: account._id,
    domain: String(account.fromEmail || '').split('@')[1] || 'unknown',
    streamCapacity: stream === 'outreach' ? 60 : 80, streamRefill: stream === 'outreach' ? 1 : 1.5,
    accountCapacity: 10, accountRefill: 0.2 });
  if (!limit.ok) {
    await defer(Math.max(1000, (limit.retryAfter || 5) * 1000));
    return;
  }

  await deliverOne({ organizationId, campaignId, recipientId, account, template, campaign });

  if (rest.length) {
    const delay = nextSendAt(sendPolicy, new Date()).getTime() - Date.now();
    await defer(delay, { ...payload, recipientIds: rest, selectionState: nextState });
  } else if (batchId) {
    // Close the batch only after its last recipient is walked.
    await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
      { $set: { status: 'done', completedAt: new Date().toISOString() } });
  }
});
