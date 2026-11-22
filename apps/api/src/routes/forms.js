import { collection, scoped, isMemoryMode } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { newId, stableHash } from '../../../../packages/shared/utils.js';
import { badRequest, notFound } from '../../../../packages/shared/errors.js';
import { writeWithOutbox } from '../../../../packages/database/outbox.js';
import { getQueue } from '../../../../packages/queue/index.js';
import { createContacts } from '../../../../packages/entitlements/contacts.js';
import { expireCryptoSubscription } from '../payments/crypto-service.js';
import { whiteLabelFor } from '../../../../packages/entitlements/branding.js';
import { audit } from '../plugins/audit.js';

/**
 * Hosted forms — the "put a form on my site and the leads land here" feature.
 *
 * A form is a small document: fields, a list it feeds, an optional automation, and a
 * public slug. Submissions are accepted from anywhere (any website, any origin) with no
 * auth, because that is what an embedded form is — so the public endpoints are the only
 * ones without a session, and they validate hard: field whitelist, honeypot, per-IP rate
 * limit, and a length cap on every value.
 */

const FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'number', 'date', 'checkbox'];

const DEFAULT_FIELDS = [
  { key: 'first_name', label: 'First name', type: 'text', required: false, placeholder: 'Dana' },
  { key: 'email', label: 'Email', type: 'email', required: true, placeholder: 'you@company.com', locked: true }
];

const slugify = (value, fallback) => {
  const base = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${base || fallback}-${stableHash(String(Date.now()), String(Math.random())).slice(0, 4)}`;
};

const normaliseFields = (input) => {
  const rows = Array.isArray(input) && input.length ? input : DEFAULT_FIELDS;
  const out = [];
  const seen = new Set();
  for (const row of rows.slice(0, 15)) {
    const key = String(row.key || row.label || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
      || `field_${out.length + 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const type = FIELD_TYPES.includes(row.type) ? row.type : 'text';
    if (key === 'email') { out.unshift({ key: 'email', label: String(row.label || 'Email').slice(0, 60), type: 'email', required: true,
      placeholder: String(row.placeholder ?? 'you@company.com').slice(0, 60), locked: true, options: [] }); continue; }
    out.push({ key, label: String(row.label || key).slice(0, 60), type,
      required: key === 'email' ? true : !!row.required,
      placeholder: String(row.placeholder || '').slice(0, 60),
      options: type === 'select' ? (Array.isArray(row.options) ? row.options.map(o => String(o).trim().slice(0, 60)).filter(Boolean).slice(0, 20) : []) : [] });
  }
  if (!seen.has('email')) out.unshift({ key: 'email', label: 'Email', type: 'email', required: true,
    placeholder: 'you@company.com', locked: true, options: [] });
  return out;
};

const isEmail = v => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(v || '').trim());

/** Per-IP guard for the public endpoint: 20 submissions per hour, memory-cheap. */
const hits = new Map();
const rateLimited = ip => {
  const now = Date.now();
  const window = 3600_000;
  const row = hits.get(ip) || { count: 0, resetAt: now + window };
  if (now > row.resetAt) { row.count = 0; row.resetAt = now + window; }
  row.count += 1;
  hits.set(ip, row);
  if (hits.size > 5000) hits.clear();
  return row.count > 20;
};

export default async function formRoutes(app) {
  // Plain HTML forms submit URL-encoded bodies; JSON remains the API default.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 32768 }, (req, body, done) => {
      try { done(null, Object.fromEntries(new URLSearchParams(body))); } catch (err) { done(err); }
    });
  }
  const assertList = async (ctx, id) => {
    if (id && (typeof id !== 'string' || !await scoped('contact_lists', ctx).findOne({ _id: id }))) throw badRequest('Choose a contact list from this workspace.');
  };
  /* ---------------------------------------------------------------- */
  /* Dashboard                                                        */
  /* ---------------------------------------------------------------- */

  app.get('/forms', async req => {
    const rows = await scoped('forms', req.ctx).find({ deleted: { $ne: true } }, { sort: { createdAt: -1 } });
    return Promise.all(rows.map(async f => ({
      ...f,
      submissions: await scoped('form_submissions', req.ctx).countDocuments({ formId: f._id }),
      publicUrl: `/f/${f.slug}`
    })));
  });

  app.post('/forms', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const name = String(req.body?.name || '').trim();
    if (name.length < 2) throw badRequest('Give the form a name (at least 2 characters)');
    await assertList(req.ctx, req.body?.listId);
    const slug = slugify(req.body?.slug || name, 'form');
    const form = await scoped('forms', req.ctx).create({
      _id: newId(), name: name.slice(0, 80), slug, status: req.body?.status === 'paused' ? 'paused' : 'live',
      headline: String(req.body?.headline || name).slice(0, 120),
      description: String(req.body?.description || '').slice(0, 400),
      submitLabel: String(req.body?.submitLabel || 'Subscribe').slice(0, 30),
      successMessage: String(req.body?.successMessage || 'Thanks — you are on the list.').slice(0, 200),
      redirectUrl: String(req.body?.redirectUrl || '').slice(0, 300),
      fields: normaliseFields(req.body?.fields),
      listId: req.body?.listId || null,
      automationId: req.body?.automationId || null,
      tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String).slice(0, 10) : [],
      doubleOptIn: !!req.body?.doubleOptIn,
      appearance: { accent: req.body?.appearance?.accent || '#2563eb',
        layout: req.body?.appearance?.layout === 'inline' ? 'inline' : 'card' },
      views: 0, createdAt: new Date().toISOString()
    });
    await audit(req.ctx, 'forms.create', 'form', { id: form._id, name: form.name });
    return form;
  });

  app.get('/forms/:id', async req => {
    const form = await scoped('forms', req.ctx).findOne({ _id: req.params.id });
    if (!form) throw notFound('Form not found');
    return { ...form, submissions: await scoped('form_submissions', req.ctx).countDocuments({ formId: form._id }) };
  });

  app.patch('/forms/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const form = await scoped('forms', req.ctx).findOne({ _id: req.params.id });
    if (!form) throw notFound('Form not found');
    const set = {};
    if (req.body?.listId !== undefined) await assertList(req.ctx, req.body.listId);
    for (const key of ['name', 'headline', 'description', 'submitLabel', 'successMessage', 'redirectUrl', 'listId', 'automationId']) {
      if (req.body?.[key] !== undefined) set[key] = typeof req.body[key] === 'string' ? req.body[key].slice(0, 400) : req.body[key];
    }
    if (req.body?.tags !== undefined) set.tags = Array.isArray(req.body.tags) ? req.body.tags.map(String).slice(0, 10) : [];
    if (req.body?.status !== undefined) set.status = req.body.status === 'paused' ? 'paused' : 'live';
    if (req.body?.fields !== undefined) set.fields = normaliseFields(req.body.fields);
    if (req.body?.doubleOptIn !== undefined) set.doubleOptIn = !!req.body.doubleOptIn;
    if (req.body?.appearance !== undefined) set.appearance = { ...(form.appearance || {}), ...req.body.appearance };
    await scoped('forms', req.ctx).updateOne({ _id: form._id }, { $set: set });
    await audit(req.ctx, 'forms.update', 'form', { id: form._id, keys: Object.keys(set) });
    return { ...form, ...set };
  });

  app.delete('/forms/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.CONTACTS_WRITE);
    const form = await scoped('forms', req.ctx).findOne({ _id: req.params.id });
    if (!form) throw notFound('Form not found');
    // Soft delete: the hosted page 404s, the submissions stay readable for export.
    await scoped('forms', req.ctx).updateOne({ _id: form._id }, { $set: { deleted: true, status: 'paused' } });
    return { ok: true, deleted: true, note: 'The hosted page is off. Submissions already collected are kept.' };
  });

  app.get('/forms/:id/submissions', async req => {
    const form = await scoped('forms', req.ctx).findOne({ _id: req.params.id });
    if (!form) throw notFound('Form not found');
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const rows = await scoped('form_submissions', req.ctx).find({ formId: form._id },
      { sort: { createdAt: -1 }, limit, skip });
    const total = await scoped('form_submissions', req.ctx).countDocuments({ formId: form._id });
    if (req.query.format === 'csv') {
      const keys = ['createdAt', 'email', ...(form.fields || []).map(f => f.key).filter(k => k !== 'email')];
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [keys.join(','), ...rows.map(r => keys.map(k => esc(r.data?.[k] ?? '')).join(','))].join('\n');
      return { csv, filename: `${form.slug}-submissions.csv`, total };
    }
    return { items: rows, total, skip, limit };
  });

  /** Everything needed to put the form on a website. */
  app.get('/forms/:id/embed', async req => {
    const form = await scoped('forms', req.ctx).findOne({ _id: req.params.id });
    if (!form) throw notFound('Form not found');
    let origin = `http://localhost:${process.env.WEB_PORT || 3000}`;
    try {
      const candidate = new URL(req.query?.origin || req.headers.origin || process.env.APP_URL || origin);
      if (candidate.protocol === 'http:' || candidate.protocol === 'https:') origin = candidate.origin;
    } catch { /* Keep the safe local fallback for malformed origins. */ }
    const whiteLabel = whiteLabelFor(await collection('organizations').findOne({ _id: form.organizationId }));
    const publicUrl = `${origin}/f/${form.slug}`;
    const endpoint = `${origin}/api/v1/public/forms/${form.slug}/submit`;
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const iframeSnippet = `<iframe src="${esc(publicUrl)}" title="${esc(form.name)}" loading="lazy"\n  style="width:100%;max-width:520px;height:520px;border:0;border-radius:16px"></iframe>`;
    const renderField = f => {
      const required = f.required ? ' required' : '';
      const name = esc(f.key), placeholder = esc(f.placeholder || '');
      let control;
      if (f.type === 'textarea') control = `<textarea name="${name}" placeholder="${placeholder}"${required}></textarea>`;
      else if (f.type === 'select') control = `<select name="${name}"${required}><option value="">${esc(f.placeholder || 'Choose…')}</option>${(f.options || []).filter(Boolean).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
      else control = `<input name="${name}" type="${esc(f.type)}"${f.type === 'checkbox' ? ' value="on"' : ` placeholder="${placeholder}"`}${required}>`;
      return `  <label>${esc(f.label)}${f.required ? ' *' : ''}\n    ${control}\n  </label>`;
    };
    const htmlSnippet = `<form action="${esc(endpoint)}" method="post" ${whiteLabel ? 'data-signup-form' : 'data-emavanta-form'}="${esc(form.slug)}">\n`
      + (form.fields || []).map(renderField).join('\n')
      + `\n  <button type="submit">${esc(form.submitLabel || 'Subscribe')}</button>\n${whiteLabel ? '' : '  <small>Powered by <a href="https://emavanta.com">Emavanta</a></small>\n'}</form>`;
    return { publicUrl, endpoint, slug: form.slug, iframeSnippet, htmlSnippet,
      note: 'Paste the iframe anywhere, or post the html form to the endpoint with fetch/form action.' };
  });

  /* ---------------------------------------------------------------- */
  /* Public (no session — this is the embedded form)                  */
  /* ---------------------------------------------------------------- */

  app.get('/public/forms/:slug', async req => {
    const form = await collection('forms').findOne({ slug: req.params.slug, deleted: { $ne: true } });
    if (!form) throw notFound('This form does not exist or was turned off');
    await collection('forms').updateOne({ _id: form._id }, { $inc: { views: 1 } });
    const org = await collection('organizations').findOne({ _id: form.organizationId });
    return { slug: form.slug, name: form.name, headline: form.headline, description: form.description,
      submitLabel: form.submitLabel, successMessage: form.successMessage, status: form.status,
      fields: (form.fields || []).map(({ key, label, type, required, placeholder, options }) =>
        ({ key, label, type, required, placeholder, options })),
      appearance: form.appearance || { accent: '#2563eb', layout: 'card' },
      organizationName: org?.name || null, whiteLabel: whiteLabelFor(org) };
  });

  app.post('/public/forms/:slug/submit', async req => {
    // Public form CORS permits third-party sites without credentials; inputs are still validated.
    const form = await collection('forms').findOne({ slug: req.params.slug, deleted: { $ne: true } });
    if (!form) throw notFound('This form does not exist or was turned off');
    if (form.status === 'paused') throw badRequest('This form is not accepting responses right now');
    if (rateLimited(req.ip || 'unknown')) throw badRequest('Too many submissions from this address — try again in an hour.');
    if (String(req.body?._hp || '').trim()) throw badRequest('Spam detected'); // honeypot

    const input = req.body?.fields && typeof req.body.fields === 'object' ? req.body.fields : req.body || {};
    const data = {};
    const errors = [];
    for (const field of form.fields || []) {
      const raw = input[field.key];
      const value = field.type === 'checkbox' ? (raw === true || raw === 'true' || raw === 'on' || raw === '1' ? 'on' : '') : (raw === undefined || raw === null ? '' : String(raw).trim().slice(0, 2000));
      if (field.required && !value) errors.push({ field: field.key, message: `${field.label} is required` });
      if (field.type === 'email' && value && !isEmail(value)) errors.push({ field: field.key, message: 'That email address looks incomplete' });
      if (field.type === 'select' && value && field.options?.length && !field.options.includes(value)) {
        errors.push({ field: field.key, message: `Choose one of: ${field.options.join(', ')}` });
      }
      data[field.key] = value;
    }
    if (errors.length) throw badRequest(errors[0].message, { fields: errors });

    if (!isMemoryMode()) await expireCryptoSubscription(form.organizationId);
    const email = String(data.email || '').toLowerCase();
    const now = new Date().toISOString();
    const contacts = collection('contacts');
    const existing = await contacts.findOne({ organizationId: form.organizationId, email, deleted: { $ne: true } });
    const requestedList = form.listId && await collection('contact_lists').findOne({ _id: form.listId, organizationId: form.organizationId }) ? [form.listId] : [];
    const profile = { firstName: data.first_name || data.firstName || existing?.firstName || '',
      lastName: data.last_name || data.lastName || existing?.lastName || '', company: data.company || existing?.company || '', phone: data.phone || existing?.phone || '' };
    await createContacts({ organizationId: form.organizationId, demo: process.env.DEMO_MODE === 'true' }, [{ email, ...profile, listIds: requestedList, source:`form:${form.slug}`, tags:form.tags || [] }]);
    const contact = await contacts.findOne({ organizationId: form.organizationId, email, deleted: { $ne: true } });
    const contactId = contact._id, listIds = new Set(contact.listIds || []);
    await contacts.updateOne({ _id: contactId }, { $set: { ...profile, lastFormAt:now, lastFormId:form._id, source:`form:${form.slug}` } });

    const submission = {
      _id: newId(), organizationId: form.organizationId, formId: form._id, formSlug: form.slug,
      contactId, email, data, listIds: [...listIds], ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown', createdAt: now
    };
    await collection('form_submissions').create(submission);

    // Automations: a form submission is a real trigger, not a label.
    let enrolled = 0;
    const automationId = form.automationId;
    if (automationId) {
      const seq = await collection('sequences').findOne({ _id: automationId, organizationId: form.organizationId });
      if (seq && seq.status === 'active') {
        await collection('scheduled_jobs').create({ _id: newId(), organizationId: form.organizationId,
          sequenceId: seq._id, contactId, step: 0, runAt: now, status: 'pending',
          source: `form:${form.slug}` });
        enrolled = 1;
      }
    }

    // One outbox event per submission: analytics, webhooks and the automation runner all
    // read it, and it survives a crash between the write and the publish.
    const { event } = await writeWithOutbox({
      organizationId: form.organizationId,
      docs: [{ name: 'delivery_events', doc: { _id: newId(), type: 'form_submitted', formId: form._id,
        formSlug: form.slug, contactId, email, createdAt: now, dedupeKey: `form:${submission._id}` } }],
      event: { type: 'form.submitted', queue: 'analytics',
        payload: { formId: form._id, formSlug: form.slug, contactId, email, organizationId: form.organizationId } }
    });
    await getQueue('outbox').add('outbox.publish', { eventId: event._id }, { jobId: `outbox-${event._id}` });

    return { ok: true, message: form.successMessage || 'Thanks — you are on the list.',
      redirectUrl: form.redirectUrl || null, submissionId: submission._id, duplicate: !!existing, enrolled };
  });

  /* Options for the form builder: which lists and automations can a form feed. */
  app.get('/forms/meta/options', async req => ({
    lists: (await scoped('contact_lists', req.ctx).find({})).map(l => ({ _id: l._id, name: l.name })),
    automations: (await scoped('sequences', req.ctx).find({})).map(s => ({ _id: s._id, name: s.name, status: s.status })),
    fieldTypes: FIELD_TYPES
  }));
}
