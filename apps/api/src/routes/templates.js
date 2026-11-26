import { scoped } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { templateSchema } from '../../../../packages/validation/index.js';
import { blocksToHtml, htmlToBlocks, switchMode, sanitizeHtml, createTemplateVersion } from '../../../../packages/email-engine/template.js';
import { preflight } from '../../../../packages/email-engine/preflight.js';
import { renderMessage } from '../../../../packages/email-engine/render.js';
import { newId } from '../../../../packages/shared/utils.js';
import { badRequest, notFound } from '../../../../packages/shared/errors.js';

export default async function templateRoutes(app) {
  app.get('/templates', async req => scoped('templates', req.ctx).find({}));

  app.get('/templates/:id', async req => {
    const t = await scoped('templates', req.ctx).findOne({ _id: req.params.id });
    if (!t) throw notFound('Template not found');
    return t;
  });

  app.post('/templates', async req => {
    assertPermission(req.ctx, PERMISSIONS.TEMPLATES_WRITE);
    const input = templateSchema.parse(req.body);
    const template = await scoped('templates', req.ctx).create({ ...createTemplateVersion(input),
      blocks: (input.blocks || []).map(b => b.type === 'raw_html' ? { ...b, content: sanitizeHtml(b.content) } : b),
      _id: newId(), styles: input.styles || {}, html: input.mode === 'code' ? sanitizeHtml(input.html || blocksToHtml(input.blocks, input.styles)) : blocksToHtml(input.blocks, input.styles),
      status: 'draft', brandKitId: input.brandKitId || null });
    return template;
  });

  app.patch('/templates/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.TEMPLATES_WRITE);
    const current = await scoped('templates', req.ctx).findOne({ _id: req.params.id });
    if (!current) throw notFound('Template not found');
    const next = createTemplateVersion({ ...current, ...req.body,
      blocks: (req.body.blocks || current.blocks || []).map(b => b.type === 'raw_html' ? { ...b, content: sanitizeHtml(b.content) } : b) });
    next.html = next.mode === 'code' ? sanitizeHtml(next.html || blocksToHtml(next.blocks, next.styles)) : blocksToHtml(next.blocks, next.styles);
    await scoped('templates', req.ctx).updateOne({ _id: current._id }, { $set: next });
    return next;
  });

  app.delete('/templates/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.TEMPLATES_WRITE);
    const current = await scoped('templates', req.ctx).findOne({ _id: req.params.id });
    if (!current) throw notFound('Template not found');
    await scoped('templates', req.ctx).deleteOne({ _id: current._id });
    return { ok: true };
  });

  // Same effect as DELETE, for clients talking to a proxy that strips DELETE bodies.
  app.post('/templates/:id/archive', async req => {
    assertPermission(req.ctx, PERMISSIONS.TEMPLATES_WRITE);
    const current = await scoped('templates', req.ctx).findOne({ _id: req.params.id });
    if (!current) throw notFound('Template not found');
    if (req.body?.purge) await scoped('templates', req.ctx).deleteOne({ _id: current._id });
    else await scoped('templates', req.ctx).updateOne({ _id: current._id }, { $set: { status: 'archived' } });
    return { ok: true, archived: true };
  });

  app.post('/templates/:id/duplicate', async req => {
    assertPermission(req.ctx, PERMISSIONS.TEMPLATES_WRITE);
    const current = await scoped('templates', req.ctx).findOne({ _id: req.params.id });
    if (!current) throw notFound('Template not found');
    const { _id, ...rest2 } = current;
    return scoped('templates', req.ctx).create({ ...rest2, _id: newId(), name: `${current.name} copy`, status: 'draft' });
  });

  app.post('/templates/:id/switch-mode', async req => {
    assertPermission(req.ctx, PERMISSIONS.TEMPLATES_WRITE);
    const current = await scoped('templates', req.ctx).findOne({ _id: req.params.id });
    if (!current) throw notFound('Template not found');
    const switched = switchMode(current, req.body.mode);
    await scoped('templates', req.ctx).updateOne({ _id: current._id }, { $set: switched });
    return { mode: switched.mode, blocks: switched.blocks, html: switched.html, preserved: true };
  });

  app.post('/templates/:id/preflight', async req => {
    const t = await scoped('templates', req.ctx).findOne({ _id: req.params.id });
    if (!t) throw notFound('Template not found');
    return preflight({ subject: t.subject, html: t.mode === 'code' ? t.html : blocksToHtml(t.blocks, t.styles),
      tokens: req.body.tokens || {}, unsubscribeUrl: req.body.unsubscribeUrl });
  });

  app.post('/templates/:id/test-render', async req => {
    const t = await scoped('templates', req.ctx).findOne({ _id: req.params.id });
    if (!t) throw notFound('Template not found');
    const html = t.mode === 'code' ? t.html : blocksToHtml(t.blocks, t.styles);
    const { renderText } = await import('../../../../packages/email-engine/personalization.js');
    return { subject: renderText(t.subject, req.body.sample || {}, { html: false }), html: renderText(html, req.body.sample || {}) };
  });

  app.post('/templates/parse-html', async req => ({ blocks: htmlToBlocks(req.body.html) }));
}
