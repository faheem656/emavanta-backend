import { scoped } from '../../../../packages/database/store.js';
import { registerWorker, getQueue, hasPendingJob } from '../../../../packages/queue/index.js';
import { nextSendAt, canSend, isWithinWindow, pacingFor } from '../../../../packages/email-engine/cadence.js';
import { eligibleAccounts, selectAccount } from '../../../../packages/email-engine/selection.js';
import { rampCapForDay } from '../../../../packages/deliverability/index.js';
import { acquireStream } from '../../../../packages/rate-limiter/index.js';
import { deliverOne, fanoutBlastBatches, tokenFallbacksFor } from './campaignRunner.js';

/**
 * ONE pacer job per campaign — the whole audience moves as a single human-paced
 * stream. The old design ran one job per batch in parallel, so a 2 000-contact
 * chunk spawned ~20 simultaneous "senders" and human mode blasted like a machine.
 * The job id is stable (`pacer-<campaignId>`) and every re-arm uses replace, so
 * at most one pacer exists per campaign no matter how many chunks arrive.
 */
const jobIdFor = campaignId => `pacer-${campaignId}`;

/**
 * How long until something can send again: a mailbox cooling down
 * (`limitedUntil`) wakes us the moment its window ends — otherwise the usual
 * 15-minute parking. Bounded to [1 min, 15 min].
 */
const wakeDelay = accounts => {
  const now = Date.now();
  const times = (accounts || [])
    .map(a => (a.limitedUntil ? Date.parse(a.limitedUntil) : NaN))
    .filter(t => Number.isFinite(t) && t > now);
  if (!times.length) return 900000;
  return Math.min(Math.max(Math.min(...times) + 5000 - now, 60000), 900000);
};

/** Recipients inspected in one tick before the cursor is persisted (bounded work). */
const SCAN_LIMIT = 120;

export const startOutreachPacer = () => registerWorker('outreach', async payload => {
  const { organizationId, campaignId } = payload || {};
  if (!organizationId || !campaignId) return;
  const ctx = { organizationId };
  const campaign = await scoped('campaigns', ctx).findOne({ _id: campaignId });
  if (!campaign) return;

  const pacerJobId = jobIdFor(campaignId);
  const defer = async (delay, nextPayload = payload) => getQueue('outreach').add('outreach.pacer', nextPayload,
    { jobId: pacerJobId, replace: true, delay: Math.max(1000, delay) });

  // Migration: legacy per-batch jobs (recipientIds/batchId in the payload) fold
  // themselves into the single campaign-level pacer instead of sending directly.
  if (payload.batchId || Array.isArray(payload.recipientIds)) {
    if (!(await hasPendingJob('outreach', pacerJobId))) {
      await defer(0, { organizationId, campaignId,
        accountPool: payload.accountPool || campaign.accountPool || [],
        rotation: payload.rotation || campaign.rotation,
        stream: payload.stream || campaign.stream });
    }
    return;
  }

  if (campaign.status === 'paused' || campaign.status === 'draft') return;

  // Mode flipped to blast (Sending pace card): stop walking one-by-one and hand
  // every unfinished batch to the fast path — the remaining list drains now.
  if (campaign.sendMode === 'blast') {
    await fanoutBlastBatches({ organizationId, campaign });
    return;
  }

  // Live policy: a daily-cap / gap / schedule / timezone edit saved mid-send is
  // read from the campaign document on this very tick — no stale launch snapshot.
  const sendPolicy = pacingFor({ ...campaign, sendPolicy: campaign.sendPolicy || payload.sendPolicy });
  const now = new Date();
  if (!isWithinWindow(sendPolicy, now)) {
    await defer(nextSendAt(sendPolicy, now).getTime() - now.getTime());
    return;
  }

  const stream = payload.stream || campaign.stream || 'outreach';
  // LIVE pool wins — swapping senders mid-flight (Sending-from card) must apply
  // on the very next tick; the launch-time payload is only a fallback.
  const accountPool = (Array.isArray(campaign.accountPool) && campaign.accountPool.length
    ? campaign.accountPool
    : (Array.isArray(payload.accountPool) && payload.accountPool.length ? payload.accountPool : []));
  const uniquePool = [...new Set(accountPool)];
  const accounts = uniquePool.length
    ? await scoped('sending_accounts', ctx).find({ _id: { $in: uniquePool } })
    : [];

  const warmupCapFor = account => {
    const warmDay = Math.max(1, Math.floor((Date.now() - Date.parse(account.createdAt || new Date().toISOString())) / 86400_000) + 1);
    return Math.min(Number(sendPolicy.dailyCap) || 50, account.warmup ? rampCapForDay(account.warmupPlan, warmDay) : Infinity);
  };
  // The campaign's own daily cap governs this campaign: the mailbox-level cap is
  // overridden in-memory so raising the campaign limit mid-send really works.
  const poolForCaps = accounts.map(a => ({ ...a, dailyCap: Number(sendPolicy.dailyCap) || a.dailyCap }));
  let candidates = eligibleAccounts(poolForCaps, { stream, now })
    .filter(account => canSend(sendPolicy, account.sentToday)
      && (account.sentToday || 0) < warmupCapFor(account)
      && (account.sentWeek || 0) < (sendPolicy.weeklyCap || 250));
  if (sendPolicy.pauseOnReply !== false) {
    const pauses = await scoped('sequence_pauses', ctx).find({ status: { $ne: 'resolved' }, accountId: { $in: candidates.map(a => a._id) } });
    if (pauses.length) {
      const pausedIds = new Set(pauses.map(pause => pause.accountId));
      candidates = candidates.filter(account => !pausedIds.has(account._id));
    }
  }

  /** Advance the batch cursor past recipients that are no longer queued. */
  const nextQueuedInBatch = async batch => {
    const ids = batch.recipientIds || [];
    let cursor = Number(batch.checkpoint) || 0;
    let scanned = 0;
    while (cursor < ids.length && scanned < SCAN_LIMIT) {
      const row = await scoped('campaign_recipients', ctx).findOne({ _id: ids[cursor] });
      scanned += 1;
      if (row && row.status === 'queued') return { recipient: row, cursor, exhausted: false };
      cursor += 1;
    }
    return { recipient: null, cursor, exhausted: cursor >= ids.length };
  };

  const batch = (await scoped('campaign_batches', ctx)
    .find({ campaignId, status: { $ne: 'done' } }, { sort: { index: 1 }, limit: 1 }))[0];

  if (!batch) {
    // No batch yet: either intake is still copying the audience, or this is a
    // legacy campaign whose recipients were never batched — walk them directly.
    const loose = await scoped('campaign_recipients', ctx).findOne({ campaignId, status: 'queued' });
    if (loose) {
      if (!candidates.length) { await defer(wakeDelay(poolForCaps)); return; }
      const { account, state: nextState } = selectAccount({ accounts: candidates,
        strategy: payload.rotation || campaign.rotation || 'round_robin',
        contactId: loose.contactId || loose._id, state: payload.selectionState || {}, stream, now });
      if (!account) { await defer(wakeDelay(poolForCaps)); return; }
      const limit = await acquireStream({ organizationId, stream, accountId: account._id,
        domain: String(account.fromEmail || '').split('@')[1] || 'unknown',
        streamCapacity: stream === 'outreach' ? 60 : 80, streamRefill: stream === 'outreach' ? 1 : 1.5,
        accountCapacity: 10, accountRefill: 0.2 });
      if (!limit.ok) { await defer(Math.max(1000, (limit.retryAfter || 5) * 1000)); return; }
      const template = await scoped('templates', ctx).findOne({ _id: campaign.templateId });
      if (!template) return;
      const tokenFallbacks = await tokenFallbacksFor(ctx);
      const delivery = await deliverOne({ organizationId, campaignId, recipientId: loose._id,
        account, template, campaign, sendPolicy, tokenFallbacks });
      if (delivery?.deferred) {
        await defer(nextSendAt(sendPolicy, new Date()).getTime() - Date.now(),
          { ...payload, selectionState: nextState });
        return;
      }
      await defer(nextSendAt(sendPolicy, new Date()).getTime() - Date.now(),
        { ...payload, selectionState: nextState });
      return;
    }

    const intake = campaign.intake || {};
    if (intake.status === 'running') {
      // Audience still copying in — the first chunk lands within milliseconds,
      // so poll briefly rather than making the first email wait a full minute.
      await defer(2000);
      return;
    }
    if (campaign.status === 'queued' && (!intake.status || intake.status === 'done')) {
      await scoped('campaigns', ctx).updateOne({ _id: campaignId, status: 'queued' },
        { $set: { status: 'completed', completedAt: new Date().toISOString() } });
    }
    // cancelled intake with nothing left to send: park quietly (Launch resumes).
    return;
  }

  const scan = await nextQueuedInBatch(batch);
  if (!scan.recipient && scan.exhausted) {
    await scoped('campaign_batches', ctx).updateOne({ _id: batch._id, status: { $ne: 'done' } },
      { $set: { status: 'done', completedAt: new Date().toISOString(), checkpoint: (batch.recipientIds || []).length } });
    // Batch closed — pick the next one on a short tick (no email was sent here).
    await defer(2000, payload);
    return;
  }
  if (!scan.recipient) {
    // Hit the scan bound with work remaining — persist the cursor and continue.
    await scoped('campaign_batches', ctx).updateOne({ _id: batch._id },
      { $set: { checkpoint: scan.cursor } });
    await defer(2000, payload);
    return;
  }

  if (!candidates.length) {
    // Every mailbox hit its (live) daily/weekly cap, is paused, or is cooling down
    // after a provider limit. Nothing sends until a cap resets, a cool-down ends
    // (we wake exactly at limitedUntil), or the user raises a limit — keep the
    // job alive instead of dropping it.
    await defer(wakeDelay(poolForCaps), payload);
    return;
  }

  const state = payload.selectionState || { cursor: Number(batch.index) || 0 };
  const { account, state: nextState } = selectAccount({ accounts: candidates,
    strategy: payload.rotation || campaign.rotation || 'round_robin',
    contactId: scan.recipient.contactId || scan.recipient._id, state, stream, now });
  if (!account) { await defer(wakeDelay(poolForCaps), payload); return; }

  const limit = await acquireStream({ organizationId, stream, accountId: account._id,
    domain: String(account.fromEmail || '').split('@')[1] || 'unknown',
    streamCapacity: stream === 'outreach' ? 60 : 80, streamRefill: stream === 'outreach' ? 1 : 1.5,
    accountCapacity: 10, accountRefill: 0.2 });
  if (!limit.ok) {
    await defer(Math.max(1000, (limit.retryAfter || 5) * 1000), { ...payload, selectionState: nextState });
    return;
  }

  const template = await scoped('templates', ctx).findOne({ _id: campaign.templateId });
  if (!template) return;
  const tokenFallbacks = await tokenFallbacksFor(ctx);

  const delivery = await deliverOne({ organizationId, campaignId, recipientId: scan.recipient._id,
    account, template, campaign, sendPolicy, tokenFallbacks });

  if (delivery?.deferred) {
    // Outside the sending window now — same recipient, resume at the next slot.
    await defer(nextSendAt(sendPolicy, new Date()).getTime() - Date.now(),
      { ...payload, selectionState: state });
    return;
  }

  // Move the cursor past the recipient we just handled, then wait out the gap.
  await scoped('campaign_batches', ctx).updateOne({ _id: batch._id },
    { $set: { checkpoint: scan.cursor + 1 } });
  await defer(nextSendAt(sendPolicy, new Date()).getTime() - Date.now(),
    { ...payload, selectionState: nextState });
});
