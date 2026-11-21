import { effectiveAddons } from '../../../../packages/entitlements/definitions.js';
import { scoped, collection, nativeDatabase, isMemoryMode } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { campaignSchema, campaignDraftSchema } from '../../../../packages/validation/index.js';
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
import { whiteLabelFor } from '../../../../packages/entitlements/branding.js';
import { renderMessage } from '../../../../packages/email-engine/render.js';
import { sendMessage } from '../../../../packages/providers/index.js';

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
      ...input, accountSelection: { rotation: input.rotation, stickyByContact: input.rotation === 'sticky_by_contact' }
    }, ...(input.startAt ? {} : { $unset: { startAt: '' } }) });
    if (!result.matchedCount) throw badRequest('Campaign is no longer a draft');
    // startAt is intentionally not supported until scheduled launch exists.
    return { ...c, ...input, status: 'draft' };
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
    const delivered = (summary.delivered || 0) + (summary.test_delivered || 0) || campaign.stats?.delivered || 0;
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
    const byAccount = {};
    for (const e of events) {
      if (!e.sendingAccountId) continue;
      byAccount[e.sendingAccountId] ||= { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0 };
      if (byAccount[e.sendingAccountId][e.type] !== undefined) byAccount[e.sendingAccountId][e.type]++;
    }
    const problems = events.filter(e => ['bounced','complained','unsubscribed','deferred'].includes(e.type)).slice(0, 100);
    return { campaign, summary, percentages, timeline, events, reviewNeeded, recipients: recipients.length,
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
    const accounts = await scoped('sending_accounts', req.ctx).find({ status: 'active' });
    const account = accounts.find(a => a._id === req.body.accountId)
      || accounts.find(a => (c.accountPool || []).includes(a._id)) || accounts[0];
    if (!account) throw badRequest('Connect a sending account first');
    const recipient = { _id: `test-${stableHash('recipient', c._id, to)}`, email: to,
      firstName: 'Test', lastName: '', company: 'Test preview', customFields: {} };
    const org=await collection('organizations').findOne({_id:req.ctx.organizationId});
    const message = renderMessage({ template, recipient, account, campaign: c, organizationId: req.ctx.organizationId, includeEmavantaBrand: !whiteLabelFor(org) });
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
    if (!['draft','paused'].includes(c.status)) throw badRequest(`Campaign is ${c.status}`);
    if (c.startAt && Date.parse(c.startAt) > Date.now()) throw badRequest('Scheduled launch is not supported yet. Launch when you are ready.');
    const template = await scoped('templates', req.ctx).findOne({ _id: c.templateId });
    if (!template) throw badRequest('Template missing');
    const html = template.mode === 'code' ? template.html : blocksToHtml(template.blocks, template.styles);
    const check = preflight({ subject: template.subject, html, tokens: {}, unsubscribeUrl: `https://track.emavanta.com/u/${c._id}` });
    if (!check.ok) throw badRequest('Preflight failed', { issues: check.issues });

    // The audience is counted, never loaded. At a million contacts this is one indexed count.
    const listIds = c.listIds || [];
    const total = await countAudience({ organizationId: req.ctx.organizationId, listIds });
    if (!total) throw badRequest('No contacts in selected lists');

    const org = await collection('organizations').findOne({ _id: req.ctx.organizationId });
    const plan = req.ctx.demo ? 'growth' : org?.plan || 'free';
    const cycle = org?.cycle || new Date().toISOString().slice(0,7);
    const addons = effectiveAddons(org);
    // Usage ledger: one row per org+cycle. It is the number the user sees in Billing,
    // and it survives restarts (a token bucket in memory used to drift and lie).
    const ledgerId = usageLedgerId(req.ctx.organizationId, cycle);
    if(!isMemoryMode()) {
      await nativeDatabase().collection('usage_counters').updateOne({_id:ledgerId},{$setOnInsert:{organizationId:req.ctx.organizationId,cycle,sends:0}},{upsert:true});
    }
    const ledger = await collection('usage_counters').findOne({ _id: ledgerId })
      || await collection('usage_counters').create({ _id: ledgerId, organizationId: req.ctx.organizationId, cycle, sends: 0 });
    const used = { ...(req.ctx.usage || {}), sends: Math.max(Number(ledger.sends || 0), await scoped('messages', req.ctx).countDocuments({})) };
    // Preview first: it must not eat allowance. Tokens are only reserved on confirm.
    const preview = checkQuota({ plan, addons, dimension: 'sends', quantity: total, used });
    if (!preview.ok) throw badRequest(
      `This plan allows ${preview.limit.toLocaleString()} sends per cycle and ${total.toLocaleString()} contacts are selected. `
      + 'Buy a send add-on or split the campaign into smaller audiences.', { quota: preview, total });

    const throughput = throughputFor(req.ctx.demo ? 'growth' : plan);
    const pacing = pacingFor(c);
    const pace = estimate({ recipients: total, mode: c.sendMode || 'human',
      gapSeconds: c.gapSeconds || pacing.minDelaySec, dailyCap: pacing.dailyCap,
      perBatch: streamConfig(c.stream).batchSize });
    if (req.body.confirm !== true) return { requiresConfirmation: true, recipients: total,
      accounts: c.accountPool.length, stream: c.stream, quota: preview, sendMode: c.sendMode || 'human',
      pace, batchSize: streamConfig(c.stream).batchSize, intakeChunk: INTAKE_CHUNK, throughput,
      note: 'Recipients are copied in the background in chunks of ' + INTAKE_CHUNK.toLocaleString() + ', so the launch returns immediately.' };

    // Backpressure: a huge standing backlog defers intake instead of melting the queue.
    const pending = await getQueue('campaign').getJobCounts();
    if (!req.ctx.demo && pending.waiting > 10_000) return { status: 'scheduled', retryAfter: 300,
      message: 'Queue above SLO threshold; campaign intake deferred. Your campaign is unchanged.' };

    const quota = reserve({ plan, addons, dimension: 'sends', quantity: total, used });
    if (!quota.ok) throw badRequest(
      `The send allowance ran out while launching ${total.toLocaleString()} contacts. Nothing was queued — buy a send add-on and launch again.`,
      { quota, total });
    // Atomic conditional increment: parallel launches cannot both reserve the
    // same remaining allowance. Preserve legacy message counts conservatively.
    if(!isMemoryMode()) await nativeDatabase().collection('usage_counters').updateOne({_id:ledgerId},{$max:{sends:used.sends}});
    const filter={_id:ledgerId,...(quota.limit<0?{}:{sends:{$lte:quota.limit-total}})};
    const reservation=await collection('usage_counters').updateOne(filter,{$inc:{sends:total}});
    if(!reservation.matchedCount)throw badRequest('The send allowance ran out while launching. Nothing was queued.',{quota,total});

    const now = new Date().toISOString();
    const changed=await scoped('campaigns', req.ctx).updateOne({ _id: c._id, status:c.status }, { $set: {
      status: 'queued', queuedAt: now,
      intake: { status: 'running', done: 0, total, chunkSize: INTAKE_CHUNK, startedAt: now }
    } });
    if(!changed.matchedCount){await collection('usage_counters').updateOne({_id:ledgerId},{$inc:{sends:-total}});throw badRequest('This campaign was already launched.');}

    // One small job kicks off the first chunk; the intake worker reschedules itself.
    await getQueue('campaign_intake').add('campaign.intake', {
      organizationId: req.ctx.organizationId, campaignId: c._id, listIds, offset: 0,
      limit: INTAKE_CHUNK, accountPool: c.accountPool, rotation: c.rotation,
      stream: c.stream, sendMode: c.sendMode || 'human', gapSeconds: c.gapSeconds,
      sendPolicy: pacing, traceId: req.id
    }, { jobId: `intake-${c._id}-0` });

    await audit(req.ctx, 'campaign.launch', 'campaign', { recipients: total, chunkSize: INTAKE_CHUNK });
    return { ok: true, campaignId: c._id, queued: total, status: 'queued',
      intake: { status: 'running', done: 0, total, chunkSize: INTAKE_CHUNK },
      sendMode: c.sendMode || 'human', pace,
      message: `Launching to ${total.toLocaleString()} contacts in chunks of ${INTAKE_CHUNK.toLocaleString()}. Sending starts immediately; you can watch progress on this page.` };
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
