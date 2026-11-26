import { collection, isMemoryMode, nativeDatabase } from '../database/store.js';
import { getQueue } from '../queue/index.js';
import { stableHash } from '../shared/utils.js';

const eventIdFor = (organizationId, sequenceId, contactId) =>
  stableHash('automation-trigger-v1', organizationId, sequenceId, contactId);

export function makeAutomationTriggerEvent({ organizationId, sequence, contactId, source, details = {} }) {
  const now = new Date().toISOString();
  return {
    _id: eventIdFor(organizationId, sequence._id, contactId), organizationId,
    sequenceId: sequence._id, contactId, trigger: sequence.trigger || 'manual', source,
    details, status: 'pending', attempts: 0, createdAt: now, updatedAt: now
  };
}

export async function publishAutomationTriggerEvents(ids = []) {
  const queue = getQueue('automation');
  for (const id of [...new Set(ids.filter(Boolean))]) {
    const event = await collection('automation_trigger_events').findOne({ _id: id, status: 'pending' });
    if (!event) continue;
    await queue.add('automation.trigger', { organizationId: event.organizationId, triggerEventId: id },
      { jobId: `automation-trigger-${id}`, retryFailed: true });
  }
  return { queued: ids.length };
}

async function storeAndPublish(events) {
  const ids = [];
  for (const event of events) {
    let existing = await collection('automation_trigger_events').findOne({ _id: event._id });
    if (!existing) {
      if (isMemoryMode()) {
        existing = await collection('automation_trigger_events').create(event);
      } else {
        try {
          await nativeDatabase().collection('automation_trigger_events').insertOne(event);
          existing = event;
        } catch (error) {
          if (error?.code !== 11000) throw error;
          existing = await collection('automation_trigger_events').findOne({ _id: event._id });
        }
      }
    }
    if (existing?.status === 'pending') ids.push(event._id);
  }
  // The event row is the durable source of truth. The periodic scheduler sweep
  // republishes pending rows if Mongo or the queue is briefly unavailable here.
  try { await publishAutomationTriggerEvents(ids); }
  catch (error) { console.warn('[automation] trigger saved; queue publish deferred to scheduler sweep.', String(error?.code || 'QUEUE_UNAVAILABLE')); }
  return ids;
}

export async function recordAutomationTriggerForSequence({ organizationId, sequenceId, contactId, source, details = {} }) {
  const sequence = await collection('sequences').findOne({ _id: sequenceId, organizationId, status: 'active', executionEnabled: true, deleted: { $ne: true } });
  if (!sequence) return { queued: false, eventId: null };
  const event = makeAutomationTriggerEvent({ organizationId, sequence, contactId, source, details });
  const ids = await storeAndPublish([event]);
  return { queued: ids.length > 0, eventId: event._id };
}

export async function recordAutomationTriggers({ organizationId, trigger, contactId, listIds = [], tags = [], formId, source, sourceId }) {
  const sequences = await collection('sequences').find({ organizationId, trigger, status: 'active', executionEnabled: true, deleted: { $ne: true } });
  const lists = new Set(listIds.map(String)), tagSet = new Set(tags.map(x => String(x).trim().toLowerCase()));
  const matches = sequences.filter(sequence => {
    if (trigger === 'contact_added') return lists.size > 0 && (!sequence.listId || lists.has(String(sequence.listId)));
    if (trigger === 'tag_added') return tagSet.size > 0 && (!sequence.triggerTag || tagSet.has(String(sequence.triggerTag).trim().toLowerCase()));
    if (trigger === 'form_submitted') return !sequence.formId || String(sequence.formId) === String(formId);
    if (trigger === 'email_opened' || trigger === 'email_clicked') return !sequence.listId || lists.has(String(sequence.listId));
    return true;
  });
  const events = matches.map(sequence => makeAutomationTriggerEvent({ organizationId, sequence, contactId, source,
    details: { ...(formId ? { formId } : {}), ...(sourceId ? { sourceId } : {}),
      ...(trigger === 'contact_added' ? { listIds: [...lists] } : {}),
      ...(trigger === 'tag_added' ? { tags: [...tagSet] } : {}) } }));
  const ids = await storeAndPublish(events);
  return { queued: ids.length, eventIds: ids };
}

export const automationTriggerEventId = eventIdFor;
