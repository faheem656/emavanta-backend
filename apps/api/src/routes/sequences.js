import { scoped } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { sequenceSchema } from '../../../../packages/validation/index.js';
import { newId } from '../../../../packages/shared/utils.js';
import { badRequest, notFound } from '../../../../packages/shared/errors.js';

export default async function sequenceRoutes(app) {
  app.get('/sequences', async req => {
    const rows = await scoped('sequences', req.ctx).find({}, { sort: { createdAt: -1 } });
    return rows.map(s => ({ ...s, stepCount: (s.steps || []).length }));
  });

  app.post('/sequences', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const input = sequenceSchema.parse(req.body);
    if (input.status === 'active') throw badRequest('Automation sending is not available yet; save this workflow as a draft.');
    return scoped('sequences', req.ctx).create({ _id: newId(), ...input, status: input.status || 'draft' });
  });

  app.patch('/sequences/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const seq = await scoped('sequences', req.ctx).findOne({ _id: req.params.id });
    if (!seq) throw notFound('Automation not found');
    const set = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (name.length < 2) throw badRequest('Name must be at least 2 characters');
      set.name = name;
    }
    for (const key of ['description','trigger','listId','formId','accountId']) {
      if (req.body[key] !== undefined) set[key] = req.body[key];
    }
    if (Array.isArray(req.body.steps)) {
      if (!req.body.steps.length) throw badRequest('At least one step is required');
      set.steps = req.body.steps;
    }
    if (req.body.status !== undefined) {
      if (!['active','paused','draft'].includes(req.body.status)) throw badRequest('Invalid status');
      if (req.body.status === 'active' && seq.status !== 'active') throw badRequest('Automation sending is not available yet; activation is disabled.');
      set.status = req.body.status;
    }
    await scoped('sequences', req.ctx).updateOne({ _id: req.params.id }, { $set: set });
    return { ok: true };
  });

  app.delete('/sequences/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    await scoped('sequences', req.ctx).deleteOne({ _id: req.params.id });
    return { ok: true };
  });

  app.get('/sequences/:id', async req => {
    const seq = await scoped('sequences', req.ctx).findOne({ _id: req.params.id });
    if (!seq) throw notFound('Automation not found');
    return { ...seq, stepCount: (seq.steps || []).length };
  });

  app.post('/sequences/:id/duplicate', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const seq = await scoped('sequences', req.ctx).findOne({ _id: req.params.id });
    if (!seq) throw notFound('Automation not found');
    const { _id, createdAt, updatedAt, ...rest } = seq;
    return scoped('sequences', req.ctx).create({ _id: newId(), ...rest, name: `${seq.name} copy`,
      status: 'paused', createdAt: new Date().toISOString() });
  });

  app.post('/sequences/:id/enroll', async req => {
    assertPermission(req.ctx, PERMISSIONS.CAMPAIGNS_WRITE);
    const seq = await scoped('sequences', req.ctx).findOne({ _id: req.params.id });
    if (!seq) throw notFound('Automation not found');
    throw badRequest('Automation sending is not available yet; enrollment is disabled.');
  });
}
