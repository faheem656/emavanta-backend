import { collection, scoped } from '../../../../packages/database/store.js';
import { registerWorker } from '../../../../packages/queue/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { classifyEvent, bumpBounceWindow } from '../../../../packages/deliverability/index.js';
import { VERIFICATION_VERSION } from '../../../../packages/email-verification/index.js';
import { guardBounceRate } from './campaignRunner.js';

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

/**
 * Providers echo back their own message id (or ours) but they never know our
 * organizationId / campaignId. Recover attribution from the message row stored
 * at send time — without this every "delivered" webhook was silently dropped
 * and the campaign page never showed delivery.
 */
const findMessage = async ref => {
  if (!ref) return null;
  try {
    return await collection('messages').findOne({ $or: [{ _id: ref }, { id: ref }, { providerMessageId: ref }] });
  } catch {
    return null;
  }
};

export const startWebhookProcessor = () => registerWorker('webhook', async ({ provider, event }) => {
  const type = classify(event);
  const ref = event.messageId || event.metadata?.messageId || event.providerMessageId || null;
  const msg = await findMessage(ref);
  const organizationId = event.organizationId || event.metadata?.organizationId || msg?.organizationId;
  if (!organizationId) return;
  const ctx = { organizationId };
  const campaignId = event.campaignId || event.metadata?.campaignId || msg?.campaignId || null;
  const contactId = event.contactId || msg?.contactId || null;
  const sendingAccountId = event.sendingAccountId || msg?.sendingAccountId || null;
  const email = String(event.email || msg?.to || '').toLowerCase().trim() || null;
  const classified = classifyEvent(event);
  const dedupeKey = event.id || event.eventId || `${provider}:${ref || email || 'unknown'}:${type}`;
  if (await scoped('delivery_events', ctx).findOne({ dedupeKey })) return; // provider retries are a no-op
  await collection('delivery_events').create({ _id: event.id || newId(), organizationId, type, provider,
    dedupeKey, classification: classified.action, providerEventId: event.id,
    messageId: msg?.id || ref, campaignId, contactId, sendingAccountId, email,
    createdAt: new Date().toISOString() });
  if ((type === 'bounced' || type === 'complained') && email) {
    await scoped('suppressions', ctx).create({ _id: newId(), email, reason: type,
      createdAt: new Date().toISOString() });
  }
  if (type === 'bounced' && email) {
    // The CONTACT flips to bounced too — visible on the contacts page (the
    // unsubscribe status is the stronger user signal and is never overwritten).
    // The verification verdict flips with it: a bounced address is INVALID no
    // matter what an earlier check said (bounce history beats DNS/SMTP).
    await scoped('contacts', ctx).updateOne({ email, status: { $ne: 'unsubscribed' } },
      { $set: { status: 'bounced', bouncedAt: new Date().toISOString(),
        verification: { status: 'INVALID', reason: 'bounced', confidence: 'high',
          riskFlags: ['bounced_after_send'], verifiedAt: new Date().toISOString(),
          version: VERIFICATION_VERSION } } });
  }
  if (type === 'bounced' && sendingAccountId) {
    // Per-mailbox bounce ledger: providers hard-block around 5 bounces/hour, so we
    // cool the mailbox down OURSELVES at the same threshold (auto stop) and the
    // sweep lifts it when the hour passes (auto resume) — the mailbox never gets
    // blocked by the provider while we keep pushing.
    const acc = await scoped('sending_accounts', ctx).findOne({ _id: sendingAccountId });
    if (acc) {
      const bounce = bumpBounceWindow(acc);
      await scoped('sending_accounts', ctx).updateOne({ _id: sendingAccountId },
        { $set: { bounceWindow: { start: bounce.start, count: bounce.count } }, $inc: { bounceTotal: 1 } });
      if (bounce.limitHit && acc.status === 'active') {
        await scoped('sending_accounts', ctx).updateOne({ _id: sendingAccountId },
          { $set: { status: 'limited', limitedUntil: bounce.until,
            lastError: `Auto-paused: ${bounce.count} bounces within one hour (provider hourly bounce limit). Sending resumes automatically.` } });
      }
    }
  }
  if (type === 'replied' && (email || contactId)) {
    await scoped('sequence_pauses', ctx).create({ _id: newId(), email, contactId,
      accountId: event.accountId || sendingAccountId, campaignId, createdAt: new Date().toISOString() });
    if (event.conversationId) await scoped('conversations', ctx).updateOne({ _id: event.conversationId }, { $set: { status: 'replied', sequencePaused: true } });
  }
  if (campaignId && ['delivered','opened','clicked','replied','bounced','complained'].includes(type)) {
    await collection('campaigns').updateOne({ _id: campaignId }, { $inc: { [`stats.${type}`]: 1 } });
    // Every bounce feeds the circuit breaker: dangerous rates pause the campaign.
    if (type === 'bounced') await guardBounceRate(organizationId, campaignId).catch(() => {});
  }
});
