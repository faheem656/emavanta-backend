/**
 * Campaign intake at scale.
 *
 * A launch never loads the audience into memory. The API counts the audience with
 * countDocuments, then a worker copies it into campaign_recipients one chunk at a
 * time. Each chunk is idempotent:
 *
 *   recipient._id  = `${campaignId}:${contactId}`   -> re-running a chunk cannot duplicate
 *   chunk._id      = `${campaignId}:${offset}`      -> a finished chunk is skipped
 *   event.dedupeKey= `queued:${recipientId}`        -> one "queued" event per recipient, ever
 *
 * Batches stay small (streamConfig size), so a job is at most a few hundred sends and
 * a crash only costs that batch (checkpointed).
 */
import { collection, scoped } from '../database/store.js';
import { writeWithOutbox } from '../database/outbox.js';
import { streamConfig } from '../deliverability/index.js';
import { newId } from '../shared/utils.js';
import { getQueue } from '../queue/index.js';

export const INTAKE_CHUNK = Math.max(200, Number(process.env.INTAKE_CHUNK || 2000));

/** Audience size without touching the rows. */
export const countAudience = async ({ organizationId, listIds }) => {
  if (!listIds?.length) return 0;
  return scoped('contacts', { organizationId }).countDocuments({
    deleted: { $ne: true },
    listIds: { $in: listIds }
  });
};

/**
 * Copy one page of contacts into recipients + batches + one outbox event.
 * Returns how many rows were added and whether the audience is exhausted.
 */
export const intakeChunk = async ({
  organizationId, campaignId, listIds = [], offset = 0, after = null, limit = INTAKE_CHUNK,
  accountPool = [], rotation, stream = 'marketing', sendMode = 'human', gapSeconds,
  sendPolicy, traceId, dryRun = false
}) => {
  const ctx = { organizationId };
  if (!listIds.length) return { added: 0, offset, done: true, batchIds: [] };

  // Cursor pagination: `after` is the last _id seen. Deep `skip` is O(offset) and would
  // crawl once the audience is in the hundreds of thousands.
  const filter = { deleted: { $ne: true }, listIds: { $in: listIds } };
  if (after) filter._id = { $gt: after };
  const contacts = await scoped('contacts', ctx).find(filter, { limit, sort: { _id: 1 } });
  if (!contacts.length) return { added: 0, offset, done: true, batchIds: [], nextAfter: after };

  const now = new Date().toISOString();
  const batchSize = Math.max(25, Math.min(500, streamConfig(stream).batchSize || 250));

  const recipients = contacts.map(ct => ({
    _id: `${campaignId}:${ct._id}`,
    organizationId, campaignId, contactId: ct._id, email: ct.email, status: 'queued', createdAt: now
  }));

  const batches = [];
  for (let i = 0; i < recipients.length; i += batchSize) {
    const slice = recipients.slice(i, i + batchSize);
    batches.push({
      _id: `batch-${campaignId}-${offset + i}`,
      organizationId, campaignId, index: offset + i, status: 'queued', checkpoint: 0,
      total: slice.length, recipientIds: slice.map(r => r._id), createdAt: now
    });
  }

  // Deterministic event id as well as dedupeKey: a retried chunk must not add a second
  // "queued" row for the same recipient.
  const events = recipients.map(r => ({
    _id: `ev-queued-${r._id}`, organizationId, type: 'queued', dedupeKey: `queued:${r._id}`,
    campaignId, contactId: r.contactId, email: r.email, createdAt: now
  }));

  const nextAfter = contacts[contacts.length - 1]._id;
  if (dryRun) return { added: recipients.length, offset, done: false, nextAfter, batchIds: batches.map(b => b._id) };

  // Deterministic ids make every write an upsert: a retried chunk adds nothing twice.
  await collection('campaign_recipients').bulkCreate(recipients);
  await collection('campaign_batches').bulkCreate(batches);
  await collection('campaign_chunks').bulkCreate([{
    _id: `${campaignId}:${offset}`, organizationId, campaignId, offset, size: recipients.length, createdAt: now
  }]);
  await collection('delivery_events').bulkCreate(events);

  // The relay turns this event into batch jobs; the writers never touch the send queues.
  const { event } = await writeWithOutbox({
    organizationId,
    docs: [],
    event: {
      type: 'campaign.execute', queue: 'outbox',
      payload: {
        campaignId, organizationId, offset, batchIds: batches.map(b => b._id),
        accountPool, rotation, stream, sendMode, gapSeconds, sendPolicy, traceId
      }
    }
  });
  await getQueue('outbox').add('outbox.publish', { eventId: event._id }, { jobId: `outbox-${event._id}` });

  return { added: recipients.length, offset, done: contacts.length < limit,
    nextAfter, batchIds: batches.map(b => b._id) };
};

/** Progress counters straight from the database — never a full scan into memory. */
export const campaignProgress = async ({ organizationId, campaignId }) => {
  const ctx = { organizationId };
  const [total, queued, sent, paused, batches, doneBatches] = await Promise.all([
    scoped('campaign_recipients', ctx).countDocuments({ campaignId }),
    scoped('campaign_recipients', ctx).countDocuments({ campaignId, status: 'queued' }),
    scoped('campaign_recipients', ctx).countDocuments({ campaignId, status: 'sent' }),
    scoped('campaign_recipients', ctx).countDocuments({ campaignId, status: 'paused' }),
    scoped('campaign_batches', ctx).countDocuments({ campaignId }),
    scoped('campaign_batches', ctx).countDocuments({ campaignId, status: 'done' })
  ]);
  return { total, queued, sent, paused, batches, doneBatches,
    percent: total ? Math.round((sent / total) * 1000) / 10 : 0 };
};
