import { scoped } from '../../../../packages/database/store.js';
import { newId, stableHash } from '../../../../packages/shared/utils.js';
import { badRequest } from '../../../../packages/shared/errors.js';
import { collection } from '../../../../packages/database/store.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DISPOSABLE = new Set(['mailinator.com','tempmail.com','guerrillamail.com','10minutemail.com']);

export default async function advanced3Routes(app) {
  // Email verification (syntax + simulated MX/disposable checks; production plugs a real verifier)
  app.post('/verification/check', async req => {
    const emails = (req.body.emails || []).slice(0, 5000);
    if (!emails.length) throw badRequest('emails array required');
    const results = emails.map(e => {
      const email = String(e).trim().toLowerCase();
      const syntax = EMAIL_RE.test(email) && email.length <= 254;
      const domain = email.split('@')[1] || '';
      const disposable = DISPOSABLE.has(domain);
      const status = !syntax ? 'invalid' : disposable ? 'disposable' : 'valid';
      return { email, status, syntax, mx: syntax && !disposable, disposable, role: /^(info|admin|sales|support)@/.test(email) };
    });
    await scoped('verification_runs', req.ctx).create({ _id: newId(), total: results.length,
      valid: results.filter(r => r.status === 'valid').length, createdAt: new Date().toISOString() });
    return { total: results.length, valid: results.filter(r => r.status === 'valid').length, results };
  });

  // Consent / evidence log
  app.get('/consent', async req => scoped('consent_records', req.ctx).find({}, { sort: { createdAt: -1 }, limit: 200 }));
  app.post('/consent', async req => {
    if (!req.body.email || !req.body.source) throw badRequest('email and source required');
    return scoped('consent_records', req.ctx).create({ _id: newId(), ...req.body,
      evidenceHash: stableHash(req.ctx.organizationId, req.body.email, req.body.source, String(req.body.textVersion || '')),
      createdAt: new Date().toISOString() });
  });

  // Outbound webhook delivery logs
  app.get('/webhooks-out/:id/logs', async req => scoped('webhook_deliveries', req.ctx)
    .find({ webhookId: req.params.id }, { sort: { createdAt: -1 }, limit: 100 }));

  // Saved segments with preview
  app.get('/segments', async req => scoped('segments', req.ctx).find({}));
  app.post('/segments', async req => scoped('segments', req.ctx).create({ _id: newId(), name: req.body.name,
    filters: req.body.filters || [], status: 'active' }));
  app.post('/segments/draft/preview', async req => {
    const rows = await scoped('contacts', req.ctx).find({}, { limit: 5000 });
    const filters = req.body.filters || [];
    const matched = rows.filter(c => filters.every(f => {
      const value = f.field === 'email' ? c.email : f.field === 'company' ? c.company : c.customFields?.[f.field];
      if (f.op === 'contains') return String(value || '').toLowerCase().includes(String(f.value || '').toLowerCase());
      if (f.op === 'equals') return String(value || '') === String(f.value || '');
      if (f.op === 'exists') return !!value;
      return true;
    }));
    return { count: matched.length, sample: matched.slice(0, 10).map(c => c.email) };
  });
  app.patch('/segments/:id', async req => {
    const set = {};
    if (req.body.name !== undefined) set.name = String(req.body.name).slice(0, 120);
    if (Array.isArray(req.body.filters)) set.filters = req.body.filters;
    if (req.body.status !== undefined) set.status = req.body.status;
    await scoped('segments', req.ctx).updateOne({ _id: req.params.id }, { $set: set });
    return { ok: true };
  });
  app.delete('/segments/:id', async req => {
    await scoped('segments', req.ctx).deleteOne({ _id: req.params.id });
    return { ok: true };
  });
  app.post('/segments/:id/preview', async req => {
    const seg = await scoped('segments', req.ctx).findOne({ _id: req.params.id });
    if (!seg) throw badRequest('Segment not found');
    const rows = await scoped('contacts', req.ctx).find({}, { limit: 5000 });
    const matched = rows.filter(c => (seg.filters || []).every(f => {
      const value = f.field === 'email' ? c.email : f.field === 'company' ? c.company : c.customFields?.[f.field];
      if (f.op === 'contains') return String(value || '').toLowerCase().includes(String(f.value || '').toLowerCase());
      if (f.op === 'equals') return String(value || '') === String(f.value || '');
      if (f.op === 'exists') return !!value;
      return true;
    }));
    return { segmentId: seg._id, count: matched.length, sample: matched.slice(0, 10).map(c => c.email) };
  });

  // Per-account send policy (cadence editor)
  // Mark all notifications read
  app.post('/notifications/read-all', async req => {
    await scoped('notifications', req.ctx).updateMany({ read: { $ne: true } }, { $set: { read: true } });
    return { ok: true };
  });
}
