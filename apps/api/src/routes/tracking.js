import { collection, scoped } from '../../../../packages/database/store.js';
import { newId } from '../../../../packages/shared/utils.js';
import { whiteLabelFor } from '../../../../packages/entitlements/branding.js';
import { verifyLink, safeRedirect } from '../../../../packages/security/links.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const escapeHtml = v => String(v || '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const decode = (token, kind) => {
  const d = verifyLink(token);
  if (!d) return null;
  // Older signed links were issued before the `kind` claim existed; still honour them.
  return !d.kind || d.kind === kind ? d : null;
};

/** One event per token + type. Pixel reloads and link prefetch never inflate stats. */
const record = async (d, type, extra = {}) => {
  const ctx = { organizationId: d.org };
  const dedupeKey = `${type}:${d.messageId || 'unknown'}:${d.email || ''}`;
  if (await scoped('delivery_events', ctx).findOne({ dedupeKey })) return false;
  await collection('delivery_events').create({ _id: newId(), organizationId: d.org, type,
    dedupeKey, campaignId: d.campaignId, contactId: d.contactId, messageId: d.messageId, email: d.email,
    sendingAccountId: d.sendingAccountId, automationId:d.automationId, automationEnrollmentId:d.automationEnrollmentId,
    sequenceStepIndex:d.sequenceStepIndex, provider: 'tracking-link', ...extra, createdAt: new Date().toISOString() });
  if (d.campaignId && ['opened', 'clicked', 'unsubscribed', 'delivered'].includes(type)) {
    await collection('campaigns').updateOne({ _id: d.campaignId }, { $inc: { [`stats.${type}`]: 1 } });
  }
  return true;
};

const unsubscribePage = (d, done = false, token = '', brand = 'Emavanta') => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe · ${escapeHtml(brand)}</title></head><body style="font-family:Inter,system-ui,sans-serif;background:#f5f7fb;color:#16263d;margin:0">
<div style="max-width:520px;margin:9vh auto;background:#fff;padding:32px;border-radius:16px;box-shadow:0 12px 34px rgba(29,58,100,.08)">
<div style="font-weight:800;font-size:19px">${escapeHtml(brand)}</div><h2 style="margin:20px 0 8px">${done ? 'You are unsubscribed' : 'Unsubscribe'}</h2>
<p style="color:#637791;line-height:1.6">${done
  ? 'We recorded your choice. Future messages to this address will be skipped.'
  : `Stop messages to <b>${escapeHtml(d.email)}</b>? Your choice is recorded immediately.`}</p>
${done ? '' : `<form method="post" action="/u/${encodeURIComponent(token)}">
  <button name="choice" value="campaign" style="padding:10px 16px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer">This campaign only</button>
  <button name="choice" value="all" style="padding:10px 16px;border:1px solid #cbd8e8;border-radius:8px;background:#fff;color:#26364c;font-weight:700;cursor:pointer;margin-left:8px">All messages</button>
</form>`}
</div></body></html>`;

/** Public, tiny, fast endpoints. Registered at root, proxied by the website. */
export default async function trackingRoutes(app) {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) app.addContentTypeParser('application/x-www-form-urlencoded', {parseAs:'string', bodyLimit:32768}, (req, body, done) => { try {done(null,Object.fromEntries(new URLSearchParams(body)));} catch(e){done(e);} });
  const brandFor = async d => { const org = await collection('organizations').findOne({_id:d.org}); return whiteLabelFor(org) ? (org?.settings?.brandName || org?.name || 'Preferences') : 'Emavanta'; };

  app.get('/u/:token', async (req, reply) => {
    const d = decode(req.params.token, 'u');
    if (!d) return reply.code(400).type('text/html').send('<h2>Invalid unsubscribe link</h2>');
    return reply.type('text/html').send(unsubscribePage(d, false, req.params.token, await brandFor(d)));
  });

  app.post('/u/:token', async (req, reply) => {
    const d = decode(req.params.token, 'u');
    if (!d) return reply.code(400).send('Invalid token');
    const scope = req.body?.choice === 'all' || req.query?.choice === 'all' ? 'all' : 'campaign';
    await record(d, 'unsubscribed', { scope });
    await scoped('suppressions', { organizationId: d.org }).create({ _id: newId(), email: d.email,
      reason: scope === 'all' ? 'unsubscribe_all' : 'unsubscribe', campaignId: d.campaignId,
      createdAt: new Date().toISOString() });
    if (d.contactId && d.campaignId) {
      await scoped('campaign_recipients', { organizationId: d.org }).updateOne({ _id: d.contactId },
        { $set: { status: 'paused', reason: 'unsubscribed' } });
    }
    return reply.type('text/html').send(unsubscribePage(d, true, '', await brandFor(d)));
  });

  // One-click unsubscribe for mail clients that follow a GET with a choice query.
  app.get('/u/:token/unsubscribe', async (req, reply) => {
    const d = decode(req.params.token, 'u');
    if (!d) return reply.code(400).send('Invalid token');
    await record(d, 'unsubscribed', { scope: 'all' });
    await scoped('suppressions', { organizationId: d.org }).create({ _id: newId(), email: d.email,
      reason: 'unsubscribe_all', createdAt: new Date().toISOString() });
    return reply.type('text/html').send(unsubscribePage(d, true, '', await brandFor(d)));
  });

  app.get('/t/l/:token', async (req, reply) => {
    const d = decode(req.params.token, 'l');
    const target = d && safeRedirect(d.url);
    if (!target) return reply.code(400).send('Invalid link');
    await record(d, 'clicked', { url: target, userAgent: req.headers['user-agent'] });
    return reply.redirect(target, 302);
  });

  app.get('/t/o/:token.gif', async (req, reply) => {
    const d = decode(req.params.token, 'o');
    if (d) await record(d, 'opened', { userAgent: req.headers['user-agent'] });
    return reply.header('content-type', 'image/gif').header('cache-control', 'no-store, no-cache, must-revalidate')
      .header('content-length', GIF.length).send(GIF);
  });
}
