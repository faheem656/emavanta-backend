import { scoped, collection } from '../../../../packages/database/store.js';
import { verifyWebhookSignature, isReplay } from '../../../../packages/providers/index.js';
import { getQueue } from '../../../../packages/queue/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { badRequest } from '../../../../packages/shared/errors.js';
import { timingSafeEqual } from 'node:crypto';

/** Hostinger hMail signs every delivery as `Authorization: Bearer <secret>` (one-time secret from webhook creation). */
const bearerMatches = (header, secret) => {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!m || !secret) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(String(secret));
  return a.length === b.length && timingSafeEqual(a, b);
};

export default async function webhookRoutes(app) {
  /**
   * The BASE webhook URL (`/api/v1/webhooks`, no mailbox id) is the classic
   * paste mistake — providers test it and used to get the session guard's
   * 401 "Sign in to continue". Answer with exact guidance instead.
   */
  const needMailboxPath = async () => {
    throw badRequest('This URL cannot receive events. Use POST /api/v1/webhooks/mailbox/:accountId — copy the exact Webhook URL from the mailbox row (Webhook URL button). Provider-wide events: POST /api/v1/webhooks/provider/:provider.');
  };
  app.get('/webhooks', needMailboxPath);
  app.post('/webhooks', needMailboxPath);

  /**
   * Per-mailbox inbound webhook: the provider POSTs signed events here
   * (/api/v1/webhooks/mailbox/:accountId). Two auth schemes, one endpoint:
   *   webhook   — HMAC-SHA256 hex in `x-webhook-signature` (generic providers)
   *   hostinger — `Authorization: Bearer <secret>` (hMail Mail API webhooks)
   * The event then flows through the same processor as provider webhooks
   * (suppression, bounce window, campaign stats).
   * `{test:true}` events prove the pipeline without touching real contacts.
   */
  app.post('/webhooks/mailbox/:accountId', async req => {
    const acc = await collection('sending_accounts').findOne({ _id: req.params.accountId });
    if (!acc?.tracking || !acc.tracking.secret) {
      throw badRequest('Tracking webhook not configured for this mailbox.');
    }
    if (acc.tracking.method === 'hostinger') {
      if (!bearerMatches(req.headers.authorization, acc.tracking.secret)) {
        throw badRequest('Invalid webhook secret');
      }
      // `message.received` = mail landed in the mailbox (DSN bounces, replies).
      // Wake the inbound poller NOW — the next sweep (≤30 s) fetches and parses
      // the message through the Mail API with the stored token. Always ack 200:
      // Hostinger's Test button and retries both depend on it.
      await collection('sending_accounts').updateOne({ _id: acc._id },
        { $set: { 'tracking.lastPolledAt': null } });
      return { ok: true, received: true };
    }
    if (acc.tracking.method !== 'webhook') {
      throw badRequest('Tracking webhook not configured for this mailbox.');
    }
    const raw = JSON.stringify(req.body);
    // TWO auth styles, ONE secret: the standard HMAC signature header AND
    // `Authorization: Bearer <secret>` — Hostinger hMail's manual webhooks (and
    // many ESPs) only send the Bearer form, which used to die here as
    // "Bad signature" → provider showed Fail on every delivery.
    const bearerOk = bearerMatches(req.headers.authorization, acc.tracking.secret);
    if (!bearerOk && !verifyWebhookSignature(raw, req.headers['x-webhook-signature'], acc.tracking.secret)) {
      throw badRequest('Bad signature — send x-webhook-signature (HMAC-SHA256 hex) or Authorization: Bearer <signing secret>.');
    }
    if (isReplay(req.headers['x-webhook-id'])) return { ok: true, duplicate: true };
    const events = Array.isArray(req.body) ? req.body : [req.body];
    let accepted = 0;
    for (const rawEvent of events) {
      if (!rawEvent || typeof rawEvent !== 'object') continue;
      if (rawEvent.test === true || rawEvent.event === 'tracking_test') continue; // pipeline ping
      const type = String(rawEvent.event || rawEvent.type || '').toLowerCase();
      const email = String(rawEvent.email || rawEvent.recipient || rawEvent.address || '').toLowerCase().trim() || null;
      if (!email && !rawEvent.messageId) continue;
      // Common provider shapes → what the processor's classifier expects.
      let mapped = type;
      if (['bounce', 'bounced', 'dropped', 'hard_bounce'].includes(type)) mapped = 'bounced';
      else if (type === 'failed') mapped = rawEvent.severity === 'permanent' ? 'bounced' : 'deferred';
      else if (type.includes('complaint') || type === 'spam') mapped = 'complained';
      else if (type.includes('open')) mapped = 'opened';
      else if (type.includes('click')) mapped = 'clicked';
      else if (type.includes('reply')) mapped = 'replied';
      else if (type.includes('defer')) mapped = 'deferred';
      else if (type.includes('deliver')) mapped = 'delivered';
      const event = {
        ...rawEvent, type: mapped, email,
        organizationId: rawEvent.organizationId || acc.organizationId,
        sendingAccountId: rawEvent.sendingAccountId || acc._id
      };
      await getQueue('webhook').add('provider.event', { provider: 'webhook', event },
        { jobId: rawEvent.id || `wh-${acc._id}-${newId()}` });
      accepted += 1;
    }
    return { ok: true, accepted };
  });

  app.post('/webhooks/provider/:provider', async req => {
    const raw = JSON.stringify(req.body);
    const secret = process.env[`${String(req.params.provider).toUpperCase()}_WEBHOOK_SECRET`];
    if (!verifyWebhookSignature(raw, req.headers['x-webhook-signature'], secret)) throw badRequest('Bad signature');
    if (isReplay(req.headers['x-webhook-id'])) return { ok: true, duplicate: true };
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const e of events) {
      await getQueue('webhook').add('provider.event', { provider: req.params.provider, event: e },
        { jobId: e.id || newId() });
    }
    return { ok: true, accepted: events.length };
  });

}
