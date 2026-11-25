import { collection, scoped, isMemoryMode } from '../../../../packages/database/store.js';
import { registerWorker, getQueue } from '../../../../packages/queue/index.js';
import { selectAccount } from '../../../../packages/email-engine/selection.js';
import { renderMessage } from '../../../../packages/email-engine/render.js';
import { sendMessage } from '../../../../packages/providers/index.js';
import { acquireStream } from '../../../../packages/rate-limiter/index.js';
import { streamConfig, throughputFor } from '../../../../packages/deliverability/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { expireCryptoSubscription } from '../payments/crypto-service.js';
import { whiteLabelFor } from '../../../../packages/entitlements/branding.js';
import { pacingFor, isWithinWindow, nextSendAt } from '../../../../packages/email-engine/cadence.js';

const domainOf = account => String(account.fromEmail || '').split('@')[1] || 'unknown';

export const deliverOne = async ({ organizationId, campaignId, recipientId, account, template, campaign, sendPolicy }) => {
  const ctx = { organizationId };
  const effectiveSendPolicy = sendPolicy || pacingFor(campaign || {});
  const scheduleNow = new Date();
  if (!isWithinWindow(effectiveSendPolicy, scheduleNow)) {
    return {
      deferred: true,
      reason: 'outside_campaign_schedule',
      nextSendAt: nextSendAt(effectiveSendPolicy, scheduleNow).toISOString()
    };
  }
  let org = await collection('organizations').findOne({ _id: organizationId });
  if (!isMemoryMode()) {
    org = await expireCryptoSubscription(organizationId);
    if (['crypto_expired','stripe_expired','platform_manual_override_expired'].includes(org?.planChangeSource) && Date.parse(campaign?.createdAt || 0) <= Date.parse(org.planExpiresAt || 0)) {
      const e=new Error('Subscription expired; this previously queued campaign is paused.'); e.code='PLAN_EXPIRED'; throw e;
    }
  }
  const recipient = await scoped('campaign_recipients', ctx).findOne({ _id: recipientId });
  if (!recipient || recipient.status !== 'queued') return { skipped: true };
  const suppressed = await scoped('suppressions', ctx).findOne({ email: recipient.email });
  if (suppressed) {
    await scoped('campaign_recipients', ctx).updateOne({ _id: recipientId, status:'queued' }, { $set: { status: 'paused', reason: 'suppressed' } });
    return { skipped: true, reason: 'suppressed' };
  }
  const pause = await scoped('sequence_pauses', ctx).findOne({ contactId: recipient.contactId, accountId: account._id });
  if (pause) {
    await scoped('campaign_recipients', ctx).updateOne({ _id: recipientId, status:'queued' }, { $set: { status: 'paused', reason: 'reply' } });
    return { skipped: true, reason: 'reply' };
  }
  const message = renderMessage({ template, recipient, account, campaign, organizationId, includeEmavantaBrand: !whiteLabelFor(org) });
  // Atomic claim stops concurrent workers from sending the same queued recipient.
  const claim=await scoped('campaign_recipients', ctx).updateOne({ _id: recipientId, status:'queued' }, { $set: { status:'sending', sendingStartedAt:new Date().toISOString() } });
  if(!claim.matchedCount)return {skipped:true,reason:'already_claimed'};
  try {
    const result = await sendMessage(account, message);
    await collection('messages').create({ ...message, organizationId, status: 'sent', providerMessageId: result.providerMessageId,
      sentAt: new Date().toISOString() });
    // Rendered snapshot for audit/debug. In production PII fields are sealed with envelope encryption + TTL.
    await scoped('message_snapshots', ctx).create({ _id: newId(), messageId: message.id, campaignId,
      subject: message.subject, html: message.html, templateVersion: message.templateVersion, createdAt: new Date().toISOString() });
    const eventBase = { organizationId, campaignId, messageId: message.id, contactId: recipient.contactId || recipient._id,
      email: recipient.email, sendingAccountId: account._id, provider: account.authMethod };
    await collection('delivery_events').create({ _id: newId(), ...eventBase, type: 'sent',
      dedupeKey: `sent:${message.id}`, providerMessageId: result.providerMessageId, createdAt: new Date().toISOString() });
    // Provider acceptance is not an inbox delivery confirmation. Only isolated mock tests synthesize delivery.
    if (account.authMethod === 'mock' && process.env.NODE_ENV==='test') {
      await collection('delivery_events').create({ _id: newId(), ...eventBase, type: 'delivered',
        dedupeKey: `delivered:${message.id}`, note: 'test mock provider accepted', createdAt: new Date().toISOString() });
      await collection('campaigns').updateOne({ _id: campaignId }, { $inc: { 'stats.delivered': 1 } });
    }
    await scoped('campaign_recipients', ctx).updateOne({ _id: recipientId }, { $set: { status: 'sent', sendingAccountId: account._id } });
    await collection('campaigns').updateOne({ _id: campaignId }, { $inc: { 'stats.sent': 1 } });
    await scoped('sending_accounts', ctx).updateOne({ _id: account._id }, { $inc: { sentToday: 1 } });
    return { ok: true, messageId: message.id };
  } catch (err) {
    const status = err.code === 'REAUTH_REQUIRED' ? 'reauth_required' : 'limited';
    await scoped('sending_accounts', ctx).updateOne({ _id: account._id }, { $set: { status, lastError: err.message } });
    await scoped('campaign_recipients', ctx).updateOne({ _id: recipientId }, { $set: { status: 'delivery_unknown', error: 'Delivery outcome requires manual review before retry.', attempts: (recipient.attempts || 0) + 1 } });
    throw err;
  }
};

const loadCampaign = async ({ organizationId, campaignId, templateId }) => {
  const ctx = { organizationId };
  const campaign = await scoped('campaigns', ctx).findOne({ _id: campaignId });
  if (!campaign) return {};
  const template = await scoped('templates', ctx).findOne({ _id: templateId || campaign.templateId });
  const accounts = await scoped('sending_accounts', ctx).find({});
  return { campaign, template, accounts };
};

/** One job = 25–250 recipients. Claims reduce duplicate sends; ambiguous outcomes need manual review. */
const runBatch = async payload => {
  const { organizationId, campaignId, batchId, recipientIds = [], accountPool = [], rotation, stream } = payload;
  const ctx = { organizationId };
  const [campaign, template, allAccounts, batch] = await Promise.all([
    scoped('campaigns', ctx).findOne({ _id: campaignId }),
    scoped('templates', ctx).findOne({ _id: (await scoped('campaigns', ctx).findOne({ _id: campaignId }))?.templateId }),
    scoped('sending_accounts', ctx).find({}),
    scoped('campaign_batches', ctx).findOne({ _id: batchId })
  ]);
  if (!campaign || !template || !batch) return;
  if (batch.status === 'done') return;
  const sendPolicy = pacingFor({ ...campaign, sendPolicy: payload.sendPolicy || campaign.sendPolicy });
  const accounts = (accountPool.length ? allAccounts.filter(a => accountPool.includes(a._id)) : allAccounts).filter(a => a.status === 'active');
  if (!accounts.length) {
    // No mailbox can send right now: keep the batch queued and retry, never drop it.
    await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
      { $set: { blockedAt: new Date().toISOString(), blockedReason: 'no_active_account' } });
    await getQueue('campaign').add('campaign.batch', { ...payload, batchId },
      { jobId: `batch-${batchId}-wait-account-${Math.floor(Date.now() / 600000)}`, delay: 600000 });
    return;
  }
  const checkpoint = batch.checkpoint || 0;
  let state = campaign.accountState || {};
  // Throughput ceiling comes from the plan, so a bigger plan really does send faster.
  const org = await collection('organizations').findOne({ _id: organizationId });
  const tp = throughputFor(org?.plan || 'growth');

    for (let i = checkpoint; i < recipientIds.length; i++) {
    const scheduleNow = new Date();
    if (!isWithinWindow(sendPolicy, scheduleNow)) {
      const retryAt = nextSendAt(sendPolicy, scheduleNow);
      await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
        { $set: { checkpoint: i, blockedAt: scheduleNow.toISOString(), blockedReason: 'campaign_schedule' } });
      await getQueue('campaign').add('campaign.batch', { ...payload, batchId },
        { jobId: `batch-${batchId}-schedule-${Math.floor(Date.now() / 60000)}`,
          delay: Math.max(1000, retryAt.getTime() - Date.now()) });
      return;
    }
    const recipientId = recipientIds[i];
    const recipient = await scoped('campaign_recipients', ctx).findOne({ _id: recipientId });
    if (!recipient || recipient.status !== 'queued') {
      await scoped('campaign_batches', ctx).updateOne({ _id: batchId }, { $set: { checkpoint: i + 1 } });
      continue;
    }
    const { account, state: next } = selectAccount({ accounts, strategy: rotation, contactId: recipientId, state, stream });
    state = next;
    if (!account) {
      // Daily caps / warmup exhausted. Park the batch at this checkpoint and come back —
      // silently skipping here used to mark the batch done and lose the rest of the list.
      await scoped('campaigns', ctx).updateOne({ _id: campaignId }, { $set: { accountState: state } });
      await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
        { $set: { checkpoint: i, blockedAt: new Date().toISOString(), blockedReason: 'daily_cap' } });
      await getQueue('campaign').add('campaign.batch', { ...payload, batchId },
        { jobId: `batch-${batchId}-cap-${Math.floor(Date.now() / 900000)}`, delay: 900000 });
      return;
    }
    const limit = await acquireStream({ organizationId, stream, accountId: account._id, domain: domainOf(account),
      streamCapacity: tp.burst, streamRefill: tp.refillPerSec,
      accountCapacity: stream === 'outreach' ? 10 : Math.max(30, Math.round(tp.burst / 4)),
      accountRefill: stream === 'outreach' ? 0.2 : tp.refillPerSec,
      domainCapacity: tp.burst * 2, domainRefill: tp.refillPerSec * 2 });
    if (!limit.ok) {
      await scoped('campaign_batches', ctx).updateOne({ _id: batchId }, { $set: { checkpoint: i, blockedAt: new Date().toISOString(), limit } });
      await getQueue('campaign').add('campaign.batch', { ...payload, batchId },
        { jobId: `batch-${batchId}-retry-${Date.now()}`, delay: Math.max(1000, (limit.retryAfter || 5) * 1000) });
      return;
    }
    try {
      const result = await deliverOne({ organizationId, campaignId, recipientId, account, template, campaign, sendPolicy });
      if (result?.deferred) {
        const retryAt = nextSendAt(sendPolicy, new Date());
        await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
          { $set: { checkpoint: i, blockedAt: new Date().toISOString(), blockedReason: 'campaign_schedule' } });
        await getQueue('campaign').add('campaign.batch', { ...payload, batchId },
          { jobId: `batch-${batchId}-schedule-${Math.floor(Date.now() / 60000)}`,
            delay: Math.max(1000, retryAt.getTime() - Date.now()) });
        return;
      }
    } catch (err) {
      await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
        { $set: { checkpoint: i, error: err.message } });
      throw err;
    }
    await scoped('campaign_batches', ctx).updateOne({ _id: batchId }, { $set: { checkpoint: i + 1 } });
  }
  await scoped('campaigns', ctx).updateOne({ _id: campaignId }, { $set: { accountState: state } });
  await scoped('campaign_batches', ctx).updateOne({ _id: batchId }, { $set: { status: 'done', completedAt: new Date().toISOString() } });
};

export const startCampaignRunner = () => registerWorker('campaign', async (payload, job) => {
  if (job?.name === 'campaign.batch' || payload.batchId) return runBatch(payload);
  const { campaignId, organizationId, recipientIds = [], accountPool = [], rotation, stream } = payload;
  const ctx = { organizationId };
  const { campaign, template, accounts: allAccounts } = await loadCampaign(payload);
  if (!campaign || !template) return;
  const accounts = (accountPool.length ? allAccounts.filter(a => accountPool.includes(a._id)) : allAccounts);

  // Human-paced campaigns go through the pacer on every stream — that is the whole
  // point of choosing it. Blast campaigns keep the fast batch path.
  const paced = stream === 'outreach' || campaign.sendMode === 'human';
  if (paced) {
    // One pacer walks each batch and chooses a sender for every recipient. Keeping the
    // whole selected pool in the job is what makes round-robin rotation independent of
    // how many mailboxes the customer connected.
    const batchIds = payload.batchIds || [];
    const lists = [];
    if (batchIds.length) {
      for (const batchId of batchIds) {
        const batch = await scoped('campaign_batches', ctx).findOne({ _id: batchId });
        if (!batch || batch.status === 'done') continue;
        lists.push({ batchId, recipientIds: batch.recipientIds || [], cursor: Number(batch.index) || 0 });
      }
    } else if (recipientIds.length) {
      lists.push({ batchId: null, recipientIds, cursor: Number(payload.offset) || 0 });
    }
    const selectedPool = campaign.accountPool?.length ? campaign.accountPool : accountPool;
    for (const { batchId, recipientIds: ids, cursor } of lists) {
      if (!ids.length) continue;
      await getQueue('outreach').add('outreach.pacer', {
        organizationId, campaignId, batchId, recipientIds: ids, accountPool: selectedPool,
        rotation: campaign.rotation || rotation || 'round_robin', stream: campaign.stream || stream,
        sendPolicy: pacingFor(campaign), selectionState: { cursor }
      }, { jobId: `pacer-${campaignId}-${batchId || 'adhoc'}` });
    }
    return;
  }

  // Fallback for events created before batching existed.
  let state = campaign.accountState || {};
  for (let i = 0; i < recipientIds.length; i++) {
    const recipientId = recipientIds[i];
    const { account, state: next } = selectAccount({ accounts, strategy: rotation, contactId: recipientId, state, stream });
    state = next;
    if (!account) continue;
    const sendPolicy = pacingFor({ ...campaign, sendPolicy: payload.sendPolicy || campaign.sendPolicy });
    const result = await deliverOne({ organizationId, campaignId, recipientId, account, template, campaign, sendPolicy });
    if (result?.deferred) {
      const retryAt = nextSendAt(sendPolicy, new Date());
      await getQueue('campaign').add('campaign.execute',
        { ...payload, recipientIds: recipientIds.slice(i), offset: (Number(payload.offset) || 0) + i },
        { jobId: `campaign-${campaignId}-schedule-${Math.floor(Date.now() / 60000)}`,
          delay: Math.max(1000, retryAt.getTime() - Date.now()) });
      return;
    }
  }
  await scoped('campaigns', ctx).updateOne({ _id: campaignId }, { $set: { accountState: state } });
});
