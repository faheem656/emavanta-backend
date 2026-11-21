import { collection, scoped } from '../../../../packages/database/store.js';
import { registerWorker } from '../../../../packages/queue/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { classifyEvent } from '../../../../packages/deliverability/index.js';

const classify = e => {
  const t = String(e.type || e.event || '').toLowerCase();
  if (t.includes('hard') || t.includes('bounce')) return 'bounced';
  if (t.includes('complaint') || t.includes('spam')) return 'complained';
  if (t.includes('deferred') || t.includes('defer')) return 'deferred';
  if (t.includes('delivered')) return 'delivered';
  if (t.includes('open')) return 'opened';
  if (t.includes('click')) return 'clicked';
  if (t.includes('reply')) return 'replied';
  return 'unknown';
};

export const startWebhookProcessor = () => registerWorker('webhook', async ({ provider, event }) => {
  const organizationId = event.organizationId || event.metadata?.organizationId;
  if (!organizationId) return;
  const type = classify(event);
  const ctx = { organizationId };
  const classified = classifyEvent(event);
  const dedupeKey = event.id || event.eventId || `${provider}:${event.messageId}:${type}`;
  if (await scoped('delivery_events', ctx).findOne({ dedupeKey })) return; // provider retries are a no-op
  await collection('delivery_events').create({ _id: event.id || newId(), organizationId, type, provider,
    dedupeKey, classification: classified.action, providerEventId: event.id, messageId: event.messageId,
    email: event.email, createdAt: new Date().toISOString() });
  if (type === 'bounced' || type === 'complained') {
    await scoped('suppressions', ctx).create({ _id: newId(), email: event.email, reason: type,
      createdAt: new Date().toISOString() });
  }
  if (type === 'replied' && (event.email || event.contactId)) {
    await scoped('sequence_pauses', ctx).create({ _id: newId(), email: event.email, contactId: event.contactId,
      accountId: event.accountId, campaignId: event.campaignId, createdAt: new Date().toISOString() });
    if (event.conversationId) await scoped('conversations', ctx).updateOne({ _id: event.conversationId }, { $set: { status: 'replied', sequencePaused: true } });
  }
  if (event.campaignId && ['delivered','opened','clicked','replied','bounced','complained'].includes(type)) {
    await collection('campaigns').updateOne({ _id: event.campaignId }, { $inc: { [`stats.${type}`]: 1 } });
  }
});
