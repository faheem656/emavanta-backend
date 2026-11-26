import { effectiveAddons } from '../../../../packages/entitlements/definitions.js';
import { scoped, collection, nativeDatabase, isMemoryMode } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS, canAccessWorkspace } from '../../../../packages/security/rbac.js';
import { campaignSchema, campaignDraftSchema, campaignPacingSchema } from '../../../../packages/validation/index.js';
import { pacingFor, estimate } from '../../../../packages/email-engine/cadence.js';
import { blocksToHtml } from '../../../../packages/email-engine/template.js';
import { preflight } from '../../../../packages/email-engine/preflight.js';
import { reserve, checkQuota, usageLedgerId } from '../../../../packages/entitlements/metering.js';
import { acquireStream } from '../../../../packages/rate-limiter/index.js';
import { getQueue } from '../../../../packages/queue/index.js';
import { countAudience, campaignProgress, INTAKE_CHUNK } from '../../../../packages/scale/intake.js';
import { writeWithOutbox } from '../../../../packages/database/outbox.js';
import { streamConfig, throughputFor } from '../../../../packages/deliverability/index.js';
import { newId, stableHash } from '../../../../packages/shared/utils.js';
import { badRequest, notFound, tooMany } from '../../../../packages/shared/errors.js';
import { audit } from '../plugins/audit.js';
import { fanoutBlastBatches, tokenFallbacksFor } from '../workers/campaignRunner.js';
import { whiteLabelFor } from '../../../../packages/entitlements/branding.js';
import { renderMessage } from '../../../../packages/email-engine/render.js';
import { sendMessage } from '../../../../packages/providers/index.js';
import { launchCampaign, scheduleLaunch, cancelSchedule, selectedSenderPool } from '../services/campaignLaunch.js';

export default async function campaignRoutes(app) {
  app.get('/campaigns', async req => scoped('campaigns', req.ctx).find({}, { sort: { createdAt: -1 } }));

  /* ---------------------------------------------------------------- */
  /* Autosave for the campaign wizard                                  */
  /*                                                                   */
  /* The browser writes its whole form state here every couple of      */
  /* seconds, so a reload, a dropped connection or a power cut resumes */
  /* exactly where it stopped instead of starting over.                */
  /* ---------------------------------------------------------------- */

  const draftKey = ctx => ({ organizationId: ctx.organizationId, userId: ctx.userId || 'owner' });

  app.get('/campaigns/drafts/current', async req => {
    const draft = await scoped('campaign_drafts', req.ctx).findOne(draftKey(req.ctx));
    return draft ? { draft } : { draft: null };
  });

  app.post('/campaigns/drafts', async req => {
    const input = campaignDraftSchema.parse(req.body || {});
    const key = draftKey(req.ctx);
    const existing = await scoped('campaign_drafts', req.ctx).findOne(key);
    const now = new Date().toISOString();
    if (existing) {
      await scoped('campaign_drafts', req.ctx).updateOne({ _id: existing._id },
        { $set: { state: input.state, campaignId: input.campaignId || null, updatedAt: now } });
      return { ok: true, draftId: existing._id, savedAt: now };
    }
    const created = await scoped('campaign_drafts', req.ctx).create({ _id: newId(), ...key,
      state: input.state, campaignId: input.campaignId || null, createdAt: now, updatedAt: now });
    return { ok: true, draftId: created._id, savedAt: now };
  });

  app.delete('/campaigns/drafts', async req => {
    const draft = await scoped('campaign_drafts', req.ctx).findOne(draftKey(req.ctx));
    if (draft) await scoped('campaign_drafts', req.ctx).deleteOne({ _id: draft._id });
    return { ok: true };
  });

  app.post('/campaigns', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const input = campaignSchema.parse(req.body);
    // Default stays human-paced; an explicit blast choice is honoured on any stream.
    const campaign = await scoped('campaigns', req.ctx).create({ _id: newId(), ...input, status: 'draft',
      sendMode: input.sendMode || 'human', gapSeconds: input.gapSeconds,
      accountSelection: { rotation: input.rotation, stickyByContact: input.rotation === 'sticky_by_contact' },
      stats: { queued: 0, sent: 0, delivered: 0, bounced: 0, replied: 0 } });
    await audit(req.ctx, 'campaign.create', 'campaign', { name: input.name });
    return campaign;
  });

  // Only editable while a campaign remains a draft; update before preflight or launch.
  app.patch('/campaigns/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    if (c.status !== 'draft') throw badRequest('Only draft campaigns can be edited');
    const input = campaignSchema.parse(req.body);
    const result = await scoped('campaigns', req.ctx).updateOne({ _id: c._id, status: 'draft' }, { $set: {
      ...input, sendMode: input.sendMode || 'human',
      accountSelection: { rotation: input.rotation, stickyByContact: input.rotation === 'sticky_by_contact' }
    }, ...(input.startAt ? {} : { $unset: { startAt: '' } }) });
    if (!result.matchedCount) throw badRequest('Campaign is no longer a draft');
    // startAt is intentionally not supported until scheduled launch exists.
    return { ...c, ...input, sendMode: input.sendMode || 'human', status: 'draft' };
  });

  /**
   * Live pacing edits: mode, daily cap, pause between emails, schedule, timezone.
   * Allowed while the campaign is queued/paused — the pacer reloads the campaign
   * document on every tick, so the new numbers apply to the very next email.
   * Flipping to blast hands the remaining batches to the fast path immediately.
   */
  app.patch('/campaigns/:id/pacing', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    const input = campaignPacingSchema.parse(req.body || {});
    const { gapSeconds, sendMode, ...policyUpdate } = input;
    const $set = { sendPolicy: { ...(c.sendPolicy || {}), ...policyUpdate } };
    if (gapSeconds !== undefined) $set.gapSeconds = gapSeconds;
    if (sendMode !== undefined) $set.sendMode = sendMode;
    await scoped('campaigns', req.ctx).updateOne({ _id: c._id }, { $set });
    const updated = { ...c, ...$set, sendPolicy: $set.sendPolicy };
    const pacing = pacingFor(updated);
    const mode = updated.sendMode || 'human';
    const pace = estimate({ recipients: 0, mode,
      gapSeconds: updated.gapSeconds || pacing.minDelaySec, dailyCap: pacing.dailyCap });
    // Mode switch while running: blast drains now, human re-arms the pacer.
    let handedOff = 0;
    if (mode === 'blast' && (c.sendMode || 'human') !== 'blast' && ['queued', 'paused'].includes(c.status)) {
      handedOff = await fanoutBlastBatches({ organizationId: req.ctx.organizationId, campaign: updated });
    } else if (mode === 'human' && c.sendMode === 'blast' && c.status === 'queued') {
      await getQueue('outreach').add('outreach.pacer', {
        organizationId: req.ctx.organizationId, campaignId: c._id,
        accountPool: updated.accountPool || [], rotation: updated.rotation,
        stream: updated.stream, sendPolicy: pacing
      }, { jobId: `pacer-${c._id}`, replace: true });
    }
    await audit(req.ctx, 'campaign.pacing_update', 'campaign',
      { sendMode: mode, dailyCap: pacing.dailyCap, gapSeconds: updated.gapSeconds ?? null,
        timezone: pacing.timezone || null, handedOff });
    return { ok: true, sendMode: mode, sendPolicy: pacing, gapSeconds: updated.gapSeconds ?? c.gapSeconds ?? null,
      pace, handedOff,
      message: mode === 'blast'
        ? (handedOff ? `Blast on — ${handedOff} batch(es) draining now.` : 'Blast mode saved.')
        : 'Pacing updated — the next email already uses the new limit.' };
  });

  /**
   * Swap the sender mailboxes of a campaign that is already running or paused.
   * The pacer and the batch runner read the LIVE pool on every tick, so the very
   * next email goes from the new mailbox set — no pause, no relaunch.
   */
  app.patch('/campaigns/:id/senders', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    if (!['queued', 'paused'].includes(c.status)) throw badRequest('Only running or paused campaigns can change senders mid-flight.');
    const ids = [...new Set((Array.isArray(req.body?.accountPool) ? req.body.accountPool : []).map(String))];
    if (!ids.length) throw badRequest('Pick at least one mailbox.');
    const updated = { ...c, accountPool: ids };
    // Same rules as launch: active, verified, in this workspace.
    await selectedSenderPool(req.ctx, updated);
    const result = await scoped('campaigns', req.ctx).updateOne({ _id: c._id, status: c.status },
      { $set: { accountPool: ids } });
    if (!result.matchedCount) throw badRequest('Campaign status changed; refresh and try again.');
    await audit(req.ctx, 'campaign.senders_update', 'campaign', { id: c._id, accountPool: ids });
    return { ok: true, accountPool: ids,
      message: `Sender pool updated — the next email goes from ${ids.length} mailbox(es).` };
  });

  app.get('/campaigns/:id', async req => {
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    return c;
  });

  app.get('/campaigns/:id/recipients', async req => scoped('campaign_recipients', req.ctx)
    .find({ campaignId: req.params.id }, { limit: Number(req.query.limit || 100) }));

  app.post('/campaigns/:id/preflight', async req => {
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    const t = await scoped('templates', req.ctx).findOne({ _id: c.templateId });
    if (!t) throw badRequest('Template missing');
    return preflight({ subject: t.subject, html: t.mode === 'code' ? t.html : blocksToHtml(t.blocks, t.styles),
      tokens: req.body.tokens || {}, unsubscribeUrl: `https://track.emavanta.com/u/${c._id}` });
  });

  /** Everything about one campaign in one call: stats, percentages, timeline and events. */
  app.get('/campaigns/:id/tracking', async req => {
    const campaign = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!campaign) throw notFound('Campaign not found');
    const events = await scoped('delivery_events', req.ctx).find({ campaignId: campaign._id },
      { sort: { createdAt: -1 }, limit: 500 });
    const recipients = await scoped('campaign_recipients', req.ctx).find({ campaignId: campaign._id }, { limit: 1000 });
    const accounts = await scoped('sending_accounts', req.ctx).find({});
    const [unknown,stalled]=await Promise.all([
      scoped('campaign_recipients',req.ctx).find({campaignId:campaign._id,status:'delivery_unknown'},{limit:25}),
      scoped('campaign_recipients',req.ctx).find({campaignId:campaign._id,status:'sending',sendingStartedAt:{$lt:new Date(Date.now()-300000).toISOString()}},{limit:25})
    ]);
    const reviewNeeded=[...unknown,...stalled].map(r=>({id:r._id,email:r.email,status:r.status}));
    const types = ['queued','sent','delivered','opened','clicked','replied','bounced','complained','deferred','unsubscribed','test_sent','test_delivered'];
    const summary = Object.fromEntries(types.map(t => [t, events.filter(e => e.type === t).length]));
    const n = (a, b) => b ? Math.round((a / b) * 1000) / 10 : 0;
    const sent = (summary.sent || 0) + (summary.test_sent || 0) || campaign.stats?.sent || 0;
    const explicitDelivered = (summary.delivered || 0) + (summary.test_delivered || 0);
    const statsDelivered = Number(campaign.stats?.delivered || 0);
    // SMTP/IMAP mailboxes never report delivery receipts, so "delivered" stayed
    // at 0 forever. When the provider has sent zero delivery events, fall back
    // to sent − bounced (the industry-standard estimate). Providers that DO
    // report keep their exact numbers.
    const deliveryEstimated = !explicitDelivered && !statsDelivered && sent > 0;
    const delivered = explicitDelivered || statsDelivered
      || (sent > 0 ? Math.max(0, sent - (summary.bounced || 0)) : 0);
    const percentages = {
      delivery: n(delivered, sent),
      open: n(summary.opened, delivered),
      click: n(summary.clicked, summary.opened),
      reply: n(summary.replied, sent),
      bounce: n(summary.bounced, sent),
      complaint: n(summary.complained, sent),
      unsubscribe: n(summary.unsubscribed, sent),
      progress: n(sent, sent + summary.queued)
    };
    const timeline = {};
    for (const e of events) {
      const day = String(e.createdAt || '').slice(0, 10) || 'unknown';
      timeline[day] ||= Object.fromEntries(types.map(t => [t, 0]));
      if (timeline[day][e.type] !== undefined) timeline[day][e.type]++;
    }
    if (deliveryEstimated) {
      summary.delivered = delivered; // the card reads summary, not the percentages
      for (const day of Object.values(timeline)) {
        day.delivered = Math.max(0, (day.sent || 0) - (day.bounced || 0));
      }
    }
    const byAccount = {};
    for (const e of events) {
      if (!e.sendingAccountId) continue;
      byAccount[e.sendingAccountId] ||= { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0 };
      if (byAccount[e.sendingAccountId][e.type] !== undefined) byAccount[e.sendingAccountId][e.type]++;
    }
    if (deliveryEstimated) {
      // Same sent − bounced estimate per mailbox when the provider reports nothing.
      for (const row of Object.values(byAccount)) row.delivered = Math.max(0, (row.sent || 0) - (row.bounced || 0));
    }
    const problems = events.filter(e => ['bounced','complained','unsubscribed','deferred'].includes(e.type)).slice(0, 100);
    // Why isn't it sending? A parked batch reason + the health of this campaign's
    // mailbox pool, so the page can say it plainly instead of "just queued".
    const openBatch = await scoped('campaign_batches', req.ctx)
      .findOne({ campaignId: campaign._id, status: { $ne: 'done' } });
    const poolIds = Array.isArray(campaign.accountPool) ? campaign.accountPool : [];
    const mailboxIssues = accounts
      .filter(a => (!poolIds.length || poolIds.includes(a._id)) && a.status && a.status !== 'active')
      .map(a => ({ fromEmail: a.fromEmail, status: a.status,
        lastError: a.lastError || null, limitedUntil: a.limitedUntil || null }));
    const blocked = openBatch?.blockedReason
      ? { reason: openBatch.blockedReason, at: openBatch.blockedAt || null } : null;
    return { campaign, summary, percentages, timeline, events, reviewNeeded, recipients: recipients.length,
      deliveryEstimated, blocked, mailboxIssues,
      byAccount: Object.fromEntries(await Promise.all(Object.entries(byAccount).map(async ([id, v]) => [
        accounts.find(a => a._id === id)?.fromEmail || id, v
      ]))), problems };
  });

  /** Send a real tracked test through a connected account (mock in demo mode). */
  app.delete('/campaigns/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    if (['running', 'launching'].includes(c.status)) throw badRequest('Pause the campaign before deleting it');
    await scoped('campaigns', req.ctx).deleteOne({ _id: c._id });
    await audit(req.ctx, 'campaign.delete', 'campaign', {});
    return { ok: true };
  });

  app.post('/campaigns/:id/test-send', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_SEND);
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    const to = String(req.body.email || req.body.to || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to) || to.length > 254) throw badRequest('Valid test recipient required');
    const template = await scoped('templates', req.ctx).findOne({ _id: c.templateId });
    if (!template) throw badRequest('Template missing');
    const accounts = await selectedSenderPool(req.ctx, c);
    if (req.body.accountId && !accounts.some(a => a._id === req.body.accountId))
      throw badRequest('Choose a mailbox from this campaign’s selected sender pool.');
    const account = req.body.accountId ? accounts.find(a => a._id === req.body.accountId) : accounts[0];
    const recipient = { _id: `test-${stableHash('recipient', c._id, to)}`, email: to };
    // Real contact data when the test address exists in the workspace — the
    // test then shows exactly what a personalized send looks like.
    const contact = await scoped('contacts', req.ctx).findOne({ email: to })
      || { firstName: 'Test', lastName: '', company: 'Test preview', customFields: {} };
    const org=await collection('organizations').findOne({_id:req.ctx.organizationId});
    const message = renderMessage({ template, recipient, account, campaign: c, organizationId: req.ctx.organizationId,
      includeEmavantaBrand: !whiteLabelFor(org), tokenFallbacks: await tokenFallbacksFor(req.ctx), contact });
    const tp=throughputFor(org?.plan||'growth'), stream=c.stream||'marketing';
    const limit=await acquireStream({organizationId:req.ctx.organizationId,stream,accountId:account._id,domain:String(account.fromEmail||'').split('@')[1]||'unknown',
      streamCapacity:stream==='outreach'?60:tp.burst,streamRefill:stream==='outreach'?1:tp.refillPerSec,
      accountCapacity:stream==='outreach'?10:Math.max(30,Math.round(tp.burst/4)),accountRefill:stream==='outreach'?.2:tp.refillPerSec,
      domainCapacity:stream==='outreach'?120:tp.burst*2,domainRefill:stream==='outreach'?2:tp.refillPerSec*2});
    if(!limit.ok)throw tooMany('Sending is temporarily rate limited. Please try again later.');
    const result = await sendMessage(account, message);
    const now = new Date().toISOString();
    const base = { organizationId: req.ctx.organizationId, campaignId: c._id, messageId: message.id,
      email: to, sendingAccountId: account._id, provider: account.authMethod };
    await collection('messages').create({ ...message, organizationId: req.ctx.organizationId,
      status: 'test_sent', providerMessageId: result.providerMessageId, sentAt: now });
    await collection('delivery_events').create({ _id: newId(), ...base, type: 'test_sent',
      dedupeKey: `test-sent:${message.id}:${Date.now()}`, createdAt: now });
    if (account.authMethod === 'mock' && process.env.NODE_ENV==='test' && result.accepted) await collection('delivery_events').create({ _id: newId(), ...base, type: 'test_delivered',
      dedupeKey: `test-delivered:${message.id}:${Date.now()}`, createdAt: now });
    await audit(req.ctx, 'campaign.test_send', 'campaign', { to, accountId: account._id });
    return { ok: true, to, subject: message.subject, messageId: message.id,
      providerMessageId: result.providerMessageId, account: account.fromEmail };
  });

  app.post('/campaigns/:id/launch', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_SEND);
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    if (!['draft','paused','scheduled'].includes(c.status)) throw badRequest(`Campaign is ${c.status}`);
    // Explicit startAt → arm a scheduled launch instead of sending now.
    if (req.body?.startAt) return scheduleLaunch(req.ctx, c, req.body.startAt);
    return launchCampaign(req.ctx, c, { confirm: req.body?.confirm === true, traceId: req.id });
  });

  /** Cancel a scheduled launch — back to draft (or paused if it had launched before). */
  app.delete('/campaigns/:id/schedule', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    return cancelSchedule(req.ctx, c);
  });

  /** Live counters for the launch banner — counts only, no row loading. */
  app.get('/campaigns/:id/progress', async req => {
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    const progress = await campaignProgress({ organizationId: req.ctx.organizationId, campaignId: c._id });
    const org = await collection('organizations').findOne({ _id: req.ctx.organizationId });
    return { ok: true, campaignId: c._id, status: c.status, intake: c.intake || null,
      throughput: throughputFor(req.ctx.demo ? 'growth' : org?.plan || 'free'), ...progress };
  });

  /** Stop a running intake (pause already stops sends). */
  app.post('/campaigns/:id/intake/cancel', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const c = await scoped('campaigns', req.ctx).findOne({ _id: req.params.id });
    if (!c) throw notFound('Campaign not found');
    await scoped('campaigns', req.ctx).updateOne({ _id: c._id }, { $set: { 'intake.status': 'cancelled' } });
    return { ok: true, intake: { ...(c.intake || {}), status: 'cancelled' } };
  });

  app.post('/campaigns/:id/pause', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    // Intake stops too: a paused campaign must not keep copying recipients in the background.
    await scoped('campaigns', req.ctx).updateOne({ _id: req.params.id }, { $set: { status: 'paused', 'intake.status': 'cancelled' } });
    await scoped('campaign_recipients', req.ctx).updateMany({ campaignId: req.params.id, status: 'queued' }, { $set: { status: 'paused' } });
    return { ok: true };
  });
}
