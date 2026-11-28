import { collection, scoped, isMemoryMode } from '../../../../packages/database/store.js';
import { registerWorker, getQueue, hasPendingJob } from '../../../../packages/queue/index.js';
import { selectAccount } from '../../../../packages/email-engine/selection.js';
import { renderMessage } from '../../../../packages/email-engine/render.js';
import { VERIFICATION_VERSION } from '../../../../packages/email-verification/index.js';
import { sendMessage } from '../../../../packages/providers/index.js';
import { acquireStream } from '../../../../packages/rate-limiter/index.js';
import { streamConfig, throughputFor, cooldownUntil, classifySendError, bumpBounceWindow, BOUNCE_PAUSE } from '../../../../packages/deliverability/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { expireCryptoSubscription } from '../payments/crypto-service.js';
import { whiteLabelFor } from '../../../../packages/entitlements/branding.js';
import { pacingFor, isWithinWindow, nextSendAt } from '../../../../packages/email-engine/cadence.js';
import { verificationGate } from '../../../../packages/email-verification/index.js';

const domainOf = account => String(account.fromEmail || '').split('@')[1] || 'unknown';

/**
 * Hand every unfinished batch of a blast campaign to the fast batch path.
 * Used when a campaign is (or becomes) blast: one job per batch, each resuming
 * from its checkpoint, so a switched campaign drains in minutes — not at the
 * human gap. Skips batches whose job is already pending so a healthy retry
 * delay is never reset.
 */
export const fanoutBlastBatches = async ({ organizationId, campaign }) => {
  const ctx = { organizationId };
  const campaignId = campaign._id;
  const batches = await scoped('campaign_batches', ctx).find({ campaignId, status: { $ne: 'done' } });
  let queued = 0;
  for (const batch of batches) {
    if (!batch.recipientIds?.length) continue;
    if (await hasPendingJob('campaign', `batch-${batch._id}`)) continue;
    await getQueue('campaign').add('campaign.batch', {
      organizationId, campaignId, batchId: batch._id, recipientIds: batch.recipientIds,
      accountPool: campaign.accountPool || [], rotation: campaign.rotation,
      stream: campaign.stream, sendMode: 'blast', sendPolicy: pacingFor(campaign)
    }, { jobId: `batch-${batch._id}`, replace: true });
    queued += 1;
  }
  return queued;
};

export const deliverOne = async ({ organizationId, campaignId, recipientId, account, template, campaign, sendPolicy, tokenFallbacks }) => {
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
  // Personalization needs the CONTACT record — the recipient row only has the
  // address. Prefer the stored contactId, fall back to the address.
  const contact = await scoped('contacts', ctx).findOne({ $or: [
    ...(recipient.contactId ? [{ _id: recipient.contactId }] : []),
    { email: recipient.email }
  ] });
  // Final verification gate — bypass-proof: even if a recipient slipped past
  // intake (paused→relaunch, API injection), INVALID never sends, PENDING waits,
  // UNKNOWN/CATCH_ALL hold per campaign policy (one policy engine: policy.js).
  const vGate = verificationGate(contact, effectiveSendPolicy);
  if (vGate) {
    await scoped('campaign_recipients', ctx).updateOne({ _id: recipientId, status: 'queued' },
      { $set: { status: 'paused', reason: vGate.reason } });
    return { skipped: true, reason: vGate.reason };
  }
  const message = renderMessage({ template, recipient, account, campaign, organizationId, includeEmavantaBrand: !whiteLabelFor(org), tokenFallbacks, contact });
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
    await scoped('sending_accounts', ctx).updateOne({ _id: account._id }, { $inc: { sentToday: 1, sentWeek: 1 } });
    return { ok: true, messageId: message.id };
  } catch (err) {
    // React to the failure the way the provider meant it — see classifySendError:
    //  - rejected → a definite recipient bounce: record everything now, keep going;
    //  - auth     → the mailbox cannot log in: nothing was sent, keep the recipient
    //               queued and flag the mailbox for reconnect (auto-resumes after);
    //  - account  → provider is holding the whole mailbox (hourly limits): cool it
    //               down with a deadline, recipient stays queued;
    //  - unknown  → ambiguous mid-send outcome: manual review, mailbox cools down.
    const kind = classifySendError(err);
    const attempts = (recipient.attempts || 0) + 1;

    if (kind === 'rejected') {
      const at = new Date().toISOString();
      const email = String(recipient.email || '').toLowerCase().trim();
      await scoped('campaign_recipients', ctx).updateOne({ _id: recipientId },
        { $set: { status: 'bounced', error: err.message, attempts, bouncedAt: at } });
      if (email && !(await scoped('suppressions', ctx).findOne({ email }))) {
        await scoped('suppressions', ctx).create({ _id: newId(), email, reason: 'bounced', createdAt: at });
      }
      if (email) {
        // The CONTACT flips too (unsubscribe is the stronger signal and wins).
        // The verification verdict flips with it — bounce history beats any
        // earlier DNS/SMTP "valid" (free protection, never re-sends).
        await scoped('contacts', ctx).updateOne({ email, status: { $ne: 'unsubscribed' } },
          { $set: { status: 'bounced', bouncedAt: at,
            verification: { status: 'INVALID', reason: 'bounced', confidence: 'high',
              riskFlags: ['bounced_after_send'], verifiedAt: at, version: VERIFICATION_VERSION } } });
      }
      await collection('delivery_events').create({ _id: newId(), organizationId, campaignId,
        contactId: recipient.contactId || recipient._id, email, sendingAccountId: account._id,
        provider: account.authMethod, type: 'bounced', dedupeKey: `bounced:${recipientId}`, createdAt: at });
      await collection('campaigns').updateOne({ _id: campaignId }, { $inc: { 'stats.bounced': 1 } });
      await guardBounceRate(organizationId, campaignId);
      const bounce = bumpBounceWindow(account);
      await scoped('sending_accounts', ctx).updateOne({ _id: account._id },
        { $set: { bounceWindow: { start: bounce.start, count: bounce.count } }, $inc: { bounceTotal: 1 } });
      if (bounce.limitHit) {
        await scoped('sending_accounts', ctx).updateOne({ _id: account._id },
          { $set: { status: 'limited', limitedUntil: bounce.until,
            lastError: `Auto-paused: ${bounce.count} bounces within one hour (provider hourly bounce limit). Sending resumes automatically.` } });
      }
      return { ok: false, bounced: true };
    }

    if (kind === 'auth') {
      await scoped('sending_accounts', ctx).updateOne({ _id: account._id },
        { $set: { status: 'reauth_required', lastError: err.message } });
      await scoped('campaign_recipients', ctx).updateOne({ _id: recipientId },
        { $set: { error: 'Mailbox needs reconnect — this email sends after it is fixed.', attempts } });
      err.code = 'REAUTH_REQUIRED';
      throw err;
    }

    if (kind === 'account') {
      await scoped('sending_accounts', ctx).updateOne({ _id: account._id },
        { $set: { status: 'limited', limitedUntil: cooldownUntil(err.message), lastError: err.message } });
      await scoped('campaign_recipients', ctx).updateOne({ _id: recipientId },
        { $set: { error: 'Mailbox is cooling down — this email sends when it resumes.', attempts } });
      throw err;
    }

    await scoped('sending_accounts', ctx).updateOne({ _id: account._id },
      { $set: { status: 'limited', limitedUntil: cooldownUntil(err.message), lastError: err.message } });
    await scoped('campaign_recipients', ctx).updateOne({ _id: recipientId },
      { $set: { status: 'delivery_unknown', error: 'Delivery outcome requires manual review before retry.', attempts } });
    throw err;
  }
};

/**
 * Bounce-rate circuit breaker — call after every bounce is counted (send-time
 * 550s and provider webhooks alike). At ≥5% bounce rate after ≥20 sends the
 * campaign pauses ITSELF for review; bounced addresses are already suppressed
 * so they are never resent, and the user resumes with the Launch button.
 */
export const guardBounceRate = async (organizationId, campaignId) => {
  const ctx = { organizationId };
  const c = await scoped('campaigns', ctx).findOne({ _id: campaignId });
  if (!c || c.status !== 'queued') return false;
  const sent = Number(c.stats?.sent || 0);
  const bounced = Number(c.stats?.bounced || 0);
  if (sent < BOUNCE_PAUSE.minSent) return false;
  const rate = bounced / sent;
  if (rate < BOUNCE_PAUSE.rate) return false;
  await scoped('campaigns', ctx).updateOne({ _id: campaignId }, { $set: {
    status: 'paused', pauseReason: 'high_bounce_rate',
    pauseDetail: `${(rate * 100).toFixed(1)}% bounce rate (${bounced} of ${sent} sent)`,
    pausedAt: new Date().toISOString(),
    intake: { ...(c.intake || {}), status: 'cancelled' }
  } });
  return true;
};

/** Registry fallbacks for {{tokens}} without an inline pipe — one read per job/tick. */
export const tokenFallbacksFor = async ctx => {
  try {
    const rows = await scoped('personalization_tokens', ctx).find({});
    return Object.fromEntries(rows.map(t => [t.token, t.fallback || '']));
  } catch { return {}; }
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
  const tokenFallbacks = await tokenFallbacksFor(ctx);
  if (!campaign || !template || !batch) return;
  if (batch.status === 'done') return;
  // A completed campaign must NEVER send again — even if the queue redelivers
  // this job after the completion flip (at-least-once delivery).
  if (['paused', 'draft', 'completed'].includes(campaign.status)) return; // Resume re-fans this batch out via the sweep.
  const blast = (payload.sendMode || campaign.sendMode) === 'blast';
  if (!blast) {
    // The campaign was switched back to human while this batch job was queued:
    // retire the fast path and re-arm the one-at-a-time pacer instead.
    await getQueue('outreach').add('outreach.pacer', {
      organizationId, campaignId, accountPool: campaign.accountPool || [],
      rotation: campaign.rotation, stream: campaign.stream, sendPolicy: pacingFor(campaign)
    }, { jobId: `pacer-${campaignId}`, replace: true });
    return;
  }
  const sendPolicy = pacingFor({ ...campaign, sendPolicy: payload.sendPolicy || campaign.sendPolicy });
  // Live pool wins (mid-flight sender swap), launch payload is the fallback.
  const livePool = Array.isArray(campaign.accountPool) && campaign.accountPool.length
    ? campaign.accountPool : accountPool;
  // Blast honours the campaign's blast daily cap (default 5 000), not the
  // mailbox's small human-mode cap — otherwise a blast stalls at 50 sends.
  const accounts = (livePool.length ? allAccounts.filter(a => livePool.includes(a._id)) : allAccounts)
    .filter(a => a.status === 'active')
    .map(a => ({ ...a, dailyCap: Number(sendPolicy.dailyCap) || a.dailyCap }));
  if (!accounts.length) {
    // No mailbox can send right now: keep the batch queued and retry, never drop it.
    await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
      { $set: { blockedAt: new Date().toISOString(), blockedReason: 'no_active_account' } });
    await getQueue('campaign').add('campaign.batch', { ...payload, batchId },
      { jobId: `batch-${batchId}`, replace: true, delay: 600000 });
    return;
  }
  const checkpoint = batch.checkpoint || 0;
  let state = campaign.accountState || {};
  // Throughput ceiling comes from the plan, so a bigger plan really does send faster.
  const org = await collection('organizations').findOne({ _id: organizationId });
  const tp = throughputFor(org?.plan || 'growth');
  if (batch.blockedReason) {
    // We are moving again — clear the parked reason so the campaign page stops
    // showing a stale "sending paused" banner.
    await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
      { $set: { blockedAt: null, blockedReason: null } });
  }

    for (let i = checkpoint; i < recipientIds.length; i++) {
    // Re-check the campaign often: a manual pause or the bounce-rate circuit
    // breaker must stop a long blast loop mid-batch, not just at job start.
    if (i > checkpoint && (i - checkpoint) % 10 === 0) {
      const fresh = await scoped('campaigns', ctx).findOne({ _id: campaignId });
      if (fresh && ['paused', 'draft'].includes(fresh.status)) {
        await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
          { $set: { checkpoint: i, blockedAt: new Date().toISOString(), blockedReason: 'paused' } });
        return; // no re-add — the sweep re-fans this batch out after Resume
      }
    }
    const scheduleNow = new Date();
    if (!isWithinWindow(sendPolicy, scheduleNow)) {
      const retryAt = nextSendAt(sendPolicy, scheduleNow);
      await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
        { $set: { checkpoint: i, blockedAt: scheduleNow.toISOString(), blockedReason: 'campaign_schedule' } });
      await getQueue('campaign').add('campaign.batch', { ...payload, batchId },
        { jobId: `batch-${batchId}`, replace: true,
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
      // Blast runs at plan throughput on every stream; only human-paced outreach
      // keeps the deliberately slow 10-burst / 0.2-per-second mailbox bucket.
      accountCapacity: (!blast && stream === 'outreach') ? 10 : Math.max(30, Math.round(tp.burst / 4)),
      accountRefill: (!blast && stream === 'outreach') ? 0.2 : tp.refillPerSec,
      domainCapacity: tp.burst * 2, domainRefill: tp.refillPerSec * 2 });
    if (!limit.ok) {
      await scoped('campaign_batches', ctx).updateOne({ _id: batchId },
        { $set: { checkpoint: i, blockedAt: new Date().toISOString(), blockedReason: 'rate_limit', limit } });
      await getQueue('campaign').add('campaign.batch', { ...payload, batchId },
        { jobId: `batch-${batchId}`, replace: true, delay: Math.max(1000, (limit.retryAfter || 5) * 1000) });
      return;
    }
    try {
      const result = await deliverOne({ organizationId, campaignId, recipientId, account, template, campaign, sendPolicy, tokenFallbacks });
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
  // Fast path: the last batch of a blast campaign flips it to completed right
  // away (human campaigns are completed by the pacer — blast has no pacer).
  await completeFinishedCampaigns({ campaignId }).catch(err =>
    console.error('[campaign] completion check failed', campaignId, String(err?.message || err)));
};

/**
 * A campaign is finished when the audience copy is done, every batch is done
 * and no recipient is still queued. The human-mode pacer has always done this;
 * blast mode had nobody — campaigns stayed "queued" forever after the last
 * email. Called after every batch, after the last intake chunk, and by the
 * scheduler sweep as a safety net for races.
 */
export async function completeFinishedCampaigns({ campaignId = null, limit = 25 } = {}) {
  const nowIso = new Date().toISOString();
  const candidates = campaignId
    ? await collection('campaigns').find({ _id: campaignId, status: 'queued' }, { limit: 1 })
    : await collection('campaigns').find({ status: 'queued' }, { limit, sort: { queuedAt: 1 } });
  let completed = 0;
  for (const c of candidates) {
    const intake = c.intake || {};
    // Copy still running (or cancelled for a later resume) → not finished.
    if (intake.status === 'running' || intake.status === 'cancelled') continue;
    const ctx = { organizationId: c.organizationId };
    const openBatches = await scoped('campaign_batches', ctx)
      .countDocuments({ campaignId: c._id, status: { $ne: 'done' } });
    if (openBatches > 0) continue;
    const left = await scoped('campaign_recipients', ctx)
      .countDocuments({ campaignId: c._id, status: 'queued' });
    if (left > 0) continue;
    const res = await scoped('campaigns', ctx).updateOne({ _id: c._id, status: 'queued' },
      { $set: { status: 'completed', completedAt: nowIso } });
    if (res.matchedCount) completed += 1;
  }
  return completed;
}

export const startCampaignRunner = () => registerWorker('campaign', async (payload, job) => {
  if (job?.name === 'campaign.batch' || payload.batchId) return runBatch(payload);
  const { campaignId, organizationId, recipientIds = [], accountPool = [], rotation, stream } = payload;
  const ctx = { organizationId };
  const { campaign, template, accounts: allAccounts } = await loadCampaign(payload);
  const tokenFallbacks = await tokenFallbacksFor(ctx);
  if (!campaign || !template) return;
  const accounts = (accountPool.length ? allAccounts.filter(a => accountPool.includes(a._id)) : allAccounts);

  // Everything paces UNLESS the campaign is explicitly blast — the user's mode
  // choice wins on every stream (outreach included). Human stays the default.
  const paced = (campaign.sendMode || payload.sendMode) !== 'blast';
  if (paced) {
    // ONE pacer per campaign, discovered batches, stable job id. The previous
    // design enqueued one pacer per batch, so every intake chunk added another
    // parallel "sender" and large lists went out in a blast instead of one-by-one.
    // Re-arm only when no pacer is already pending: replacing a healthy (or
    // in-flight) job would cancel its human gap and let a second tick race ahead.
    if (!(await hasPendingJob('outreach', `pacer-${campaignId}`))) {
      const selectedPool = campaign.accountPool?.length ? campaign.accountPool : accountPool;
      await getQueue('outreach').add('outreach.pacer', {
        organizationId, campaignId,
        accountPool: selectedPool,
        rotation: campaign.rotation || rotation || 'round_robin',
        stream: campaign.stream || stream,
        sendPolicy: pacingFor(campaign)
      }, { jobId: `pacer-${campaignId}`, replace: true });
    }
    return;
  }

  // Launched as human, switched to blast mid-flight: the relay still paces the
  // incoming chunks (its payload predates the switch), so fan their batches out
  // here from the live campaign document instead of dropping them.
  if (payload.batchIds?.length) {
    for (const batchId of payload.batchIds) {
      if (await hasPendingJob('campaign', `batch-${batchId}`)) continue;
      const batch = await scoped('campaign_batches', ctx).findOne({ _id: batchId });
      if (!batch || batch.status === 'done' || !batch.recipientIds?.length) continue;
      await getQueue('campaign').add('campaign.batch',
        { ...payload, batchId, recipientIds: batch.recipientIds, sendMode: 'blast' },
        { jobId: `batch-${batchId}`, replace: true });
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
    const result = await deliverOne({ organizationId, campaignId, recipientId, account, template, campaign, sendPolicy, tokenFallbacks });
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
