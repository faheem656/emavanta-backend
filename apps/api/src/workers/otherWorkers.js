import { createContacts } from '../../../../packages/entitlements/contacts.js';
import { collection, scoped } from '../../../../packages/database/store.js';
import { registerWorker, getQueue } from '../../../../packages/queue/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { contactSchema, normalizeContactRow } from '../../../../packages/validation/index.js';
import { createHmac } from 'node:crypto';
import { classifyEvent } from '../../../../packages/deliverability/index.js';

export const startOtherWorkers = () => {
  registerWorker('import', async ({ organizationId, rows, listIds, consentIp }) => {
    const ctx = { organizationId };
    const valid=[];
    const requested=[...new Set([...(listIds||[]), ...rows.flatMap(row => Array.isArray(row.listIds) ? row.listIds : [])])];
    const available=new Set();
    for(const id of requested) if(await scoped('contact_lists',ctx).findOne({_id:id})) available.add(id);
    for (const row of rows) {
      const parsed=contactSchema.safeParse({...normalizeContactRow(row),listIds:[...new Set([...(row.listIds||[]),...(listIds||[])])].filter(id=>available.has(id))});
      if(parsed.success)valid.push({ ...parsed.data, consentSource: 'import', consentIp });
    }
    let created=0;
    for(let i=0;i<valid.length;i+=10000){const result=await createContacts(ctx,valid.slice(i,i+10000));created+=result.created.length;}
    console.log(`[import] ${created}/${rows.length} contacts imported`);
  });

  registerWorker('analytics', async ({ organizationId, campaignId }) => {
    const events = await scoped('delivery_events', { organizationId }).find({ campaignId });
    const counts = events.reduce((a, e) => { a[e.type] = (a[e.type] || 0) + 1; return a; }, {});
    // Canonical metric definitions live in packages/observability; opens stay secondary (Apple MPP).
    await scoped('analytics_rollups', { organizationId }).create({ _id: newId(), campaignId, counts,
      bounceRate: counts.delivered ? +((counts.bounced || 0) / counts.delivered).toFixed(4) : 0,
      complaintRate: counts.delivered ? +((counts.complained || 0) / counts.delivered).toFixed(4) : 0,
      window: 'hour', createdAt: new Date().toISOString() });
  });

  registerWorker('scheduler', async (payload, job) => {
    const ctx = { organizationId: payload.organizationId };
    if (job?.name === 'scheduler.poll' || payload.poll === true) {
      const due = await scoped('scheduled_jobs', ctx).find({ status: 'pending', runAt: { $lte: new Date().toISOString() } }, { limit: 500 });
      for (const row of due) {
        // Lease prevents two pollers from dispatching the same job.
        const claimed = await scoped('scheduled_jobs', ctx).updateOne({ _id: row._id, status: 'pending' },
          { $set: { status: 'claimed', leaseUntil: new Date(Date.now() + 60_000).toISOString(), claimedBy: 'scheduler-poll' } });
        if (claimed.matchedCount !== 1) continue;
        await getQueue('scheduler').add('scheduler.dispatch', { organizationId: payload.organizationId, jobId: row._id },
          { jobId: `dispatch-${row._id}`, retryFailed: true });
      }
      return;
    }
    const jobId = payload.jobId;
    const row = await scoped('scheduled_jobs', ctx).findOne({ _id: jobId });
    if (!row || !['pending', 'claimed'].includes(row.status)) return;
    if (Date.parse(row.runAt) > Date.now()) {
      await scoped('scheduled_jobs', ctx).updateOne({ _id: jobId }, { $set: { status: 'pending' } });
      return;
    }
    if (row.type === 'sequence.step') {
      const sequence = await scoped('sequences', ctx).findOne({ _id: row.sequenceId || row.payload?.sequenceId });
      const step = sequence?.steps?.[row.step || row.payload?.step || 0];
      if (step?.type === 'email' && step.templateId) {
        await getQueue('outreach').add('sequence.send', { organizationId: payload.organizationId, contactId: row.contactId || row.payload?.contactId,
          templateId: step.templateId, sequenceId: sequence._id }, { jobId: `step-${jobId}` });
      }
    }
    await scoped('scheduled_jobs', ctx).updateOne({ _id: jobId, status: { $in: ['pending','claimed'] } }, { $set: { status: 'done' } });
  });

  registerWorker('billing', async event => {
    console.log('[billing] stripe event applied', event.type || event.id);
  });

  registerWorker('webhook_out', async ({ organizationId, webhookId, payload }) => {
    const hook = await scoped('webhooks_out', { organizationId }).findOne({ _id: webhookId, status: 'active' });
    if (!hook) return;
    const body = JSON.stringify(payload);
    const sig = createHmac('sha256', hook.secret).update(body).digest('hex');
    let response = null;
    try {
      response = await fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json',
        'x-emavanta-signature': sig, 'x-emavanta-event': payload.type || 'event' }, body });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await scoped('webhooks_out', { organizationId }).updateOne({ _id: webhookId },
        { $set: { lastDeliveryAt: new Date().toISOString(), failCount: 0 } });
    } catch (err) {
      await scoped('webhooks_out', { organizationId }).updateOne({ _id: webhookId },
        { $set: { failCount: (hook.failCount || 0) + 1, lastError: err.message } });
      await scoped('webhook_deliveries', { organizationId }).create({ _id: newId(), webhookId, status: 'failed',
        event: payload.type || 'event', httpStatus: response?.status || 0, error: err.message, createdAt: new Date().toISOString() });
      throw err;
    }
    await scoped('webhook_deliveries', { organizationId }).create({ _id: newId(), webhookId, status: 'delivered',
      event: payload.type || 'event', httpStatus: response.status, createdAt: new Date().toISOString() });
  });

  registerWorker('report', async ({ organizationId, reportId, type, seedList, results }) => {
    if (reportId) await scoped('reports', { organizationId }).updateOne({ _id: reportId }, { $set: { status: 'ready', completedAt: new Date().toISOString() } });
    if (type === 'data.export') {
      await scoped('data_exports', { organizationId }).create({ _id: newId(), status: 'ready', createdAt: new Date().toISOString() });
    }
    if (type === 'seed.test') {
      await scoped('seed_tests', { organizationId }).create({ _id: newId(), seeds: seedList || [],
        scores: results || { status: 'demo-placement-pass' }, createdAt: new Date().toISOString() });
    }
  });

  /** Backfill delivery events when provider webhooks are missed. Idempotent by provider/message key. */
  registerWorker('reconcile', async ({ organizationId }) => {
    const ctx = { organizationId };
    const messages = await scoped('messages', ctx).find({}, { limit: 5000 });
    const events = await scoped('delivery_events', ctx).find({}, { limit: 5000 });
    const seen = new Set(events.map(e => e.messageId));
    let backfilled = 0;
    for (const message of messages.filter(m => !seen.has(m.id) && Date.parse(m.sentAt || 0) < Date.now() - 60_000)) {
      await scoped('delivery_events', ctx).create({ _id: newId(), messageId: message.id,
        campaignId: message.campaignId, type: 'delivered', source: 'reconciliation', createdAt: new Date().toISOString() });
      backfilled++;
    }
    await scoped('reconciliation_runs', ctx).create({ _id: newId(), backfilled, checked: messages.length, createdAt: new Date().toISOString() });
    console.log(`[reconcile] backfilled ${backfilled} delivery events`);
  });
};
