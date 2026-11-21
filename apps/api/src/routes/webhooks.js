import { scoped, collection } from '../../../../packages/database/store.js';
import { verifyWebhookSignature, isReplay } from '../../../../packages/providers/index.js';
import { getQueue } from '../../../../packages/queue/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { badRequest } from '../../../../packages/shared/errors.js';

export default async function webhookRoutes(app) {
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
