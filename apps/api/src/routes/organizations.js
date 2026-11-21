import { scoped, collection } from '../../../../packages/database/store.js';
import { assertPermission, PERMISSIONS } from '../../../../packages/security/rbac.js';
import { audit } from '../plugins/audit.js';
import { badRequest, forbidden, notFound } from '../../../../packages/shared/errors.js';

export default async function orgRoutes(app) {
  app.get('/organizations/current', async req => {
    const org = req.ctx.demo
      ? { _id: 'demo-org', name: 'Demo Org', plan: 'growth', settings: { timezone: 'UTC' } }
      : await collection('organizations').findOne({ _id: req.ctx.organizationId });
    const members = await scoped('memberships', req.ctx).find({});
    return { organization: org, memberCount: members.length };
  });
  app.get('/organizations/current/deletion', async req => {
    if (req.ctx.demo) return { status: 'active', softDelete: true, graceDays: 30, demo: true };
    const org = await collection('organizations').findOne({ _id: req.ctx.organizationId });
    return { status: org?.status || 'active', requestedAt: org?.deletionRequestedAt || null,
      purgeAt: org?.purgeAt || null, graceDays: 30, softDelete: true };
  });

  /** Soft delete: the workspace is frozen, never wiped — 30 days to restore. */
  app.delete('/organizations/current', async req => {
    assertPermission(req.ctx, PERMISSIONS.ORG_SETTINGS);
    if (req.ctx.user.role !== 'owner') throw forbidden('Only the workspace owner can delete the workspace');
    const org = req.ctx.demo ? { _id: 'demo-org', name: 'Demo Org' }
      : await collection('organizations').findOne({ _id: req.ctx.organizationId });
    if (!org) throw notFound('Workspace not found');
    const typed = String(req.body?.confirmName || '').trim();
    if (typed !== org.name) throw badRequest('Type the workspace name exactly to confirm deletion');
    if (req.ctx.demo) {
      await audit(req.ctx, 'org.soft_delete', 'organization', { demo: true });
      return { ok: true, status: 'pending_deletion', softDelete: true, graceDays: 30, purgeAt: null,
        note: 'Demo workspace: deletion is simulated. Sign up for a real workspace to exercise the 30-day grace period.' };
    }
    const purgeAt = new Date(Date.now() + 30 * 864e5).toISOString();
    await collection('organizations').updateOne({ _id: org._id }, { $set: { status: 'pending_deletion',
      deletionRequestedAt: new Date().toISOString(), deletionRequestedBy: req.ctx.user.id, purgeAt } });
    await audit(req.ctx, 'org.soft_delete', 'organization', { purgeAt });
    return { ok: true, status: 'pending_deletion', softDelete: true, graceDays: 30, purgeAt };
  });

  app.post('/organizations/current/restore', async req => {
    assertPermission(req.ctx, PERMISSIONS.ORG_SETTINGS);
    if (req.ctx.demo) return { ok: true, status: 'active' };
    await collection('organizations').updateOne({ _id: req.ctx.organizationId },
      { $set: { status: 'active', deletionRequestedAt: null, deletionRequestedBy: null, purgeAt: null } });
    await audit(req.ctx, 'org.restore', 'organization', {});
    return { ok: true, status: 'active' };
  });

  app.patch('/organizations/current', async req => {
    assertPermission(req.ctx, PERMISSIONS.ORG_SETTINGS);
    await scoped('organizations', req.ctx).updateOne({ _id: req.ctx.organizationId }, { $set: { settings: req.body.settings || {} } });
    await audit(req.ctx, 'org.update', 'organization', { keys: Object.keys(req.body.settings || {}) });
    return { ok: true };
  });
}
