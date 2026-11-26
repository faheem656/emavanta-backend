/**
 * Campaign launch core — shared by the HTTP launch route and the scheduler
 * sweep (scheduled campaigns fire startAt → sweep calls launchDueCampaigns).
 *
 * launchCampaign performs the FULL launch: preflight, audience count, quota
 * reservation, status flip to `queued`, pacer arm and the first intake job.
 * scheduleLaunch only arms a future start; nothing sends until the sweep runs
 * the launch at (or after) startAt.
 */
import { scoped, collection, nativeDatabase, isMemoryMode } from '../../../../packages/database/store.js';
import { canAccessWorkspace } from '../../../../packages/security/rbac.js';
import { badRequest } from '../../../../packages/shared/errors.js';
import { pacingFor, estimate } from '../../../../packages/email-engine/cadence.js';
import { blocksToHtml } from '../../../../packages/email-engine/template.js';
import { preflight } from '../../../../packages/email-engine/preflight.js';
import { reserve, checkQuota, usageLedgerId } from '../../../../packages/entitlements/metering.js';
import { effectiveAddons } from '../../../../packages/entitlements/definitions.js';
import { getQueue } from '../../../../packages/queue/index.js';
import { countAudience, INTAKE_CHUNK } from '../../../../packages/scale/intake.js';
import { streamConfig, throughputFor } from '../../../../packages/deliverability/index.js';
import { audit } from '../plugins/audit.js';

/** A campaign may send only from its explicitly selected, organization-scoped, verified mailbox pool. */
export const selectedSenderPool = async (ctx, campaign) => {
  const ids = Array.isArray(campaign.accountPool) ? campaign.accountPool : [];
  if (!ids.length) throw badRequest('Select at least one verified sending mailbox before launch.');
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== ids.length) throw badRequest('Remove duplicate mailboxes from the sender pool.');
  const accounts = await scoped('sending_accounts', ctx).find({ _id: { $in: uniqueIds } });
  if (accounts.length !== uniqueIds.length) throw badRequest('One or more selected mailboxes is unavailable in this workspace.');
  const now = Date.now();
  const invalid = accounts.some(account => account.status !== 'active'
    || (account.authMethod === 'mock' && process.env.NODE_ENV !== 'test')
    || (account.tokenExpiresAt && (!Number.isFinite(Date.parse(account.tokenExpiresAt)) || Date.parse(account.tokenExpiresAt) <= now))
    || !canAccessWorkspace(ctx, account.workspaceId));
  if (invalid) throw badRequest('Every selected mailbox must be active, verified, and accessible. Reconnect or remove any mailbox that needs attention.');
  if (accounts.some(account => account.stream && account.stream !== campaign.stream))
    throw badRequest(`Every selected mailbox must support the ${campaign.stream} stream. Update the pool or mailbox stream.`);
  return accounts;
};

/**
 * Arm a future start. Validates everything that can fail fast (senders,
 * template, audience) NOW so the scheduled fire never surprises the user.
 * `startAt` must be a valid ISO datetime strictly in the future (≤ 90 days).
 */
export async function scheduleLaunch(ctx, campaign, startAtRaw) {
  const t = Date.parse(String(startAtRaw || ''));
  if (!Number.isFinite(t)) throw badRequest('Pick a valid date and time to schedule this campaign.');
  if (t <= Date.now() + 60_000) throw badRequest('Schedule time must be at least a minute in the future.');
  if (t > Date.now() + 90 * 24 * 3600 * 1000) throw badRequest('You can schedule up to 90 days ahead.');
  if (!['draft', 'paused', 'scheduled'].includes(campaign.status))
    throw badRequest(`Campaign is ${campaign.status}`);
  await selectedSenderPool(ctx, campaign);
  const template = await scoped('templates', ctx).findOne({ _id: campaign.templateId });
  if (!template) throw badRequest('Template missing');
  const total = await countAudience({ organizationId: ctx.organizationId, listIds: campaign.listIds || [] });
  if (!total) throw badRequest('No contacts in selected lists');
  const startIso = new Date(t).toISOString();
  const res = await scoped('campaigns', ctx).updateOne(
    { _id: campaign._id, status: { $in: ['draft', 'paused', 'scheduled'] } },
    { $set: { status: 'scheduled', startAt: startIso, scheduleAttempts: 0, scheduleLastError: null } });
  if (!res.matchedCount) throw badRequest('Campaign changed; refresh and try again.');
  await audit(ctx, 'campaign.schedule', 'campaign', { startAt: startIso });
  return { ok: true, status: 'scheduled', startAt: startIso,
    message: `Scheduled for ${new Date(t).toLocaleString()} — it launches automatically then.` };
}

/** Revert a scheduled campaign back to draft (or paused if it had launched before). */
export async function cancelSchedule(ctx, campaign) {
  if (campaign.status !== 'scheduled') throw badRequest('This campaign is not scheduled.');
  const backTo = Number(campaign.intake?.total || 0) > 0 ? 'paused' : 'draft';
  const res = await scoped('campaigns', ctx).updateOne({ _id: campaign._id, status: 'scheduled' },
    { $set: { status: backTo, scheduleAttempts: 0 }, $unset: { startAt: '' } });
  if (!res.matchedCount) throw badRequest('Campaign changed; refresh and try again.');
  await audit(ctx, 'campaign.unschedule', 'campaign', { restored: backTo });
  return { ok: true, status: backTo, message: 'Schedule cancelled — nothing will send until you launch again.' };
}

/**
 * The actual launch. `confirm:false` returns the preview (counts, quota, pace)
 * without side effects — the wizard's confirmation modal uses it.
 */
export async function launchCampaign(ctx, c, { confirm = true, traceId = 'internal' } = {}) {
  if (!['draft', 'paused', 'scheduled'].includes(c.status)) throw badRequest(`Campaign is ${c.status}`);
  const senderPool = await selectedSenderPool(ctx, c);
  const template = await scoped('templates', ctx).findOne({ _id: c.templateId });
  if (!template) throw badRequest('Template missing');
  const html = template.mode === 'code' ? template.html : blocksToHtml(template.blocks, template.styles);
  const check = preflight({ subject: template.subject, html, tokens: {}, unsubscribeUrl: `https://track.emavanta.com/u/${c._id}` });
  if (!check.ok) throw badRequest('Preflight failed', { issues: check.issues });

  // The audience is counted, never loaded. At a million contacts this is one indexed count.
  const listIds = c.listIds || [];
  const total = await countAudience({ organizationId: ctx.organizationId, listIds });
  if (!total) throw badRequest('No contacts in selected lists');

  const org = await collection('organizations').findOne({ _id: ctx.organizationId });
  const plan = ctx.demo ? 'growth' : org?.plan || 'free';
  const cycle = org?.cycle || new Date().toISOString().slice(0, 7);
  const addons = effectiveAddons(org);
  // Usage ledger: one row per org+cycle. It is the number the user sees in Billing,
  // and it survives restarts (a token bucket in memory used to drift and lie).
  const ledgerId = usageLedgerId(ctx.organizationId, cycle);
  if (!isMemoryMode()) {
    await nativeDatabase().collection('usage_counters').updateOne({ _id: ledgerId },
      { $setOnInsert: { organizationId: ctx.organizationId, cycle, sends: 0 } }, { upsert: true });
  }
  const ledger = await collection('usage_counters').findOne({ _id: ledgerId })
    || await collection('usage_counters').create({ _id: ledgerId, organizationId: ctx.organizationId, cycle, sends: 0 });
  const used = { ...(ctx.usage || {}), sends: Math.max(Number(ledger.sends || 0), await scoped('messages', ctx).countDocuments({})) };
  // Relaunching a paused campaign must not pay for the same audience twice: the
  // first launch already reserved these contacts, so only the growth (new
  // contacts added while paused) consumes fresh allowance. A scheduled campaign
  // that was armed from a paused state carries the same intake total.
  const priorIntake = Number(c.intake?.total || 0);
  const previousReserved = priorIntake > 0 && ['paused', 'scheduled'].includes(c.status) ? priorIntake : 0;
  const toReserve = Math.max(0, total - previousReserved);
  // Preview first: it must not eat allowance. Tokens are only reserved on confirm.
  const preview = checkQuota({ plan, addons, dimension: 'sends', quantity: toReserve, used });
  if (!preview.ok) throw badRequest(
    `This plan allows ${preview.limit.toLocaleString()} sends per cycle and ${total.toLocaleString()} contacts are selected. `
    + 'Buy a send add-on or split the campaign into smaller audiences.', { quota: preview, total });

  const throughput = throughputFor(ctx.demo ? 'growth' : plan);
  const pacing = pacingFor(c);
  const sendMode = c.sendMode || 'human';
  const pace = estimate({ recipients: total, mode: sendMode,
    gapSeconds: c.gapSeconds || pacing.minDelaySec, dailyCap: pacing.dailyCap,
    perBatch: streamConfig(c.stream).batchSize });
  if (confirm !== true) return { requiresConfirmation: true, recipients: total,
    accounts: senderPool.length, stream: c.stream, quota: preview, sendMode,
    pace, batchSize: streamConfig(c.stream).batchSize, intakeChunk: INTAKE_CHUNK, throughput,
    note: 'Recipients are copied in the background in chunks of ' + INTAKE_CHUNK.toLocaleString() + ', so the launch returns immediately.' };

  // Backpressure: a huge standing backlog defers intake instead of melting the queue.
  const pending = await getQueue('campaign').getJobCounts();
  if (!ctx.demo && pending.waiting > 10_000) return { status: 'scheduled', retryAfter: 300,
    message: 'Queue above SLO threshold; campaign intake deferred. Your campaign is unchanged.' };

  const quota = reserve({ plan, addons, dimension: 'sends', quantity: toReserve, used });
  if (!quota.ok) throw badRequest(
    `The send allowance ran out while launching ${total.toLocaleString()} contacts. Nothing was queued — buy a send add-on and launch again.`,
    { quota, total });
  // Atomic conditional increment: parallel launches cannot both reserve the
  // same remaining allowance. Preserve legacy message counts conservatively.
  if (!isMemoryMode()) await nativeDatabase().collection('usage_counters').updateOne({ _id: ledgerId }, { $max: { sends: used.sends } });
  const filter = { _id: ledgerId, ...(quota.limit < 0 ? {} : { sends: { $lte: quota.limit - toReserve } }) };
  const reservation = await collection('usage_counters').updateOne(filter, { $inc: { sends: toReserve } });
  if (!reservation.matchedCount) throw badRequest('The send allowance ran out while launching. Nothing was queued.', { quota, total });

  const now = new Date().toISOString();
  const changed = await scoped('campaigns', ctx).updateOne({ _id: c._id, status: c.status }, { $set: {
    status: 'queued', queuedAt: now, sendMode,
    intake: { status: 'running', done: 0, total, chunkSize: INTAKE_CHUNK, startedAt: now },
    pauseReason: null, pauseDetail: null, pausedAt: null
  }, $unset: { startAt: '' } });
  if (!changed.matchedCount) {
    await collection('usage_counters').updateOne({ _id: ledgerId }, { $inc: { sends: -toReserve } });
    throw badRequest('This campaign was already launched.');
  }

  // Resume after a pause: recipients the pause button parked (no reason) go back to
  // queued. Suppressed / replied / unsubscribed recipients keep their pause.
  await scoped('campaign_recipients', ctx).updateMany(
    { campaignId: c._id, status: 'paused', $or: [{ reason: { $exists: false } }, { reason: null }] },
    { $set: { status: 'queued', reason: null } });

  // Human campaigns start one campaign-level pacer; blast waits for the intake
  // batches and then drains them through the fast batch path (relay decides).
  if (sendMode !== 'blast') {
    await getQueue('outreach').add('outreach.pacer', {
      organizationId: ctx.organizationId, campaignId: c._id,
      accountPool: c.accountPool, rotation: c.rotation, stream: c.stream, sendPolicy: pacing
    }, { jobId: `pacer-${c._id}`, replace: true });
  }

  // One small job kicks off the first chunk; the intake worker reschedules itself.
  await getQueue('campaign_intake').add('campaign.intake', {
    organizationId: ctx.organizationId, campaignId: c._id, listIds, offset: 0,
    limit: INTAKE_CHUNK, accountPool: c.accountPool, rotation: c.rotation,
    stream: c.stream, sendMode, gapSeconds: c.gapSeconds,
    sendPolicy: pacing, traceId
  }, { jobId: `intake-${c._id}-0` });

  await audit(ctx, 'campaign.launch', 'campaign', { recipients: total, chunkSize: INTAKE_CHUNK, sendMode });
  return { ok: true, campaignId: c._id, queued: total, status: 'queued',
    intake: { status: 'running', done: 0, total, chunkSize: INTAKE_CHUNK },
    sendMode, pace,
    message: `Launching to ${total.toLocaleString()} contacts in chunks of ${INTAKE_CHUNK.toLocaleString()}. Sending starts immediately; you can watch progress on this page.` };
}

/**
 * Fire every scheduled campaign whose startAt has passed (called by the
 * scheduler sweep every 30s). A campaign that fails repeatedly is parked as
 * paused with the reason so the user sees it instead of a silent retry loop.
 */
export async function launchDueCampaigns() {
  const nowIso = new Date().toISOString();
  const due = await collection('campaigns').find(
    { status: 'scheduled', startAt: { $lte: nowIso } },
    { limit: 5, sort: { startAt: 1 } });
  let launched = 0;
  for (const c of due) {
    try {
      await launchCampaign({ organizationId: c.organizationId, demo: false }, c,
        { confirm: true, traceId: 'scheduler' });
      launched += 1;
    } catch (e) {
      const attempts = Number(c.scheduleAttempts || 0) + 1;
      const message = String(e?.message || e);
      const update = { scheduleAttempts: attempts, scheduleLastError: message };
      if (attempts >= 5) {
        update.status = 'paused';
        update.pauseReason = 'schedule_failed';
        update.pauseDetail = `Scheduled launch failed ${attempts} times: ${message}`;
        update.scheduledFailedAt = nowIso;
      }
      await collection('campaigns').updateOne({ _id: c._id, status: 'scheduled' }, { $set: update });
      console.error('[scheduler] scheduled campaign launch failed', c._id, message);
    }
  }
  return launched;
}
