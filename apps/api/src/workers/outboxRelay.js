import { collection, scoped } from '../../../../packages/database/store.js';
import { registerWorker, getQueue } from '../../../../packages/queue/index.js';
import { markPublished } from '../../../../packages/database/outbox.js';

/**
 * Which campaigns must be sent by the human-cadence pacer rather than a bulk batch.
 * Exported so the rule is testable. Everything paces unless the user explicitly
 * chose blast — that choice wins on every stream (outreach included), while
 * legacy payloads without a mode keep the safe human default.
 */
export const shouldPace = payload => payload?.sendMode !== 'blast';

/**
 * Reliable outbox relay: DB event -> persistent queue with deterministic jobId.
 * Campaign sends are fanned out into checkpointed batches here, so the API
 * never writes to the queue itself (no dual-write window).
 */
export const startOutboxRelay = () => registerWorker('outbox', async payload => {
  const eventId = payload.eventId || payload._id;
  const found = await collection('outbox_events').find({ _id: eventId, status: 'pending' });
  const event = found[0] || (payload.type ? payload : null);
  if (!event) return;
  try {
    // Anything the user marked "human-paced" goes through the pacer, whatever the stream.
    // Without this the batch fan-out below would blast a campaign the user asked to slow down.
    const paced = shouldPace(event.payload);
    if (event.type === 'campaign.execute' && paced) {
      await getQueue('campaign').add('campaign.execute', { ...event.payload, eventId: event._id },
        { jobId: `outbox-${event._id}` });
    } else if (event.type === 'campaign.execute') {
      const batchIds = event.payload?.batchIds || [];
      if (batchIds.length) {
        for (const batchId of batchIds) {
          const batch = await scoped('campaign_batches', { organizationId: event.organizationId }).findOne({ _id: batchId });
          if (!batch || batch.status === 'done') continue;
          await getQueue('campaign').add('campaign.batch', { ...event.payload, batchId, recipientIds: batch.recipientIds },
            { jobId: `batch-${batchId}` });
        }
      } else {
        await getQueue('campaign').add('campaign.execute', { ...event.payload, eventId: event._id },
          { jobId: `outbox-${event._id}` });
      }
    } else {
      await getQueue(event.queue || 'outbox').add(event.type || 'event', event.payload || {},
        { jobId: `outbox-${event._id || 'inline'}` });
    }
    await markPublished(event._id);
  } catch (err) {
    // Keep the event pending so retry or the sweep can recover it.
    throw err;
  }
});
