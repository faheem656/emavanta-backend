/**
 * Transactional outbox helper. Business documents and the outbox event are
 * written in one Mongo transaction (or one memory batch in demo mode).
 * A relay publishes afterwards with a deterministic jobId: no dual-write gap.
 */
import { collection, isMemoryMode, withMongoTransaction } from './store.js';
import { newId } from '../shared/utils.js';

export const writeWithOutbox = async ({ docs = [], event, organizationId }) => {
  const outboxEvent = { _id: newId(), organizationId, status: 'pending',
    createdAt: new Date().toISOString(), ...event };

  if (isMemoryMode()) {
    const saved = [];
    for (const { name, doc } of docs) saved.push(await collection(name).create({ ...doc, organizationId }));
    const savedEvent = await collection('outbox_events').create(outboxEvent);
    return { docs: saved, event: savedEvent };
  }

  return withMongoTransaction(async (db, session) => {
    const saved = [];
    for (const { name, doc } of docs) {
      const row = { ...doc, _id: doc._id || newId(), organizationId };
      await db.collection(name).insertOne(row, { session });
      saved.push(row);
    }
    await db.collection('outbox_events').insertOne(outboxEvent, { session });
    return { docs: saved, event: outboxEvent };
  });
};

export const markPublished = async eventId => {
  if (!eventId) return;
  await collection('outbox_events').updateOne({ _id: eventId },
    { $set: { status: 'published', publishedAt: new Date().toISOString() } });
};

export const markFailed = async (eventId, error) => {
  if (!eventId) return;
  await collection('outbox_events').updateOne({ _id: eventId },
    { $set: { status: 'failed', error: String(error).slice(0, 500), failedAt: new Date().toISOString() } });
};
