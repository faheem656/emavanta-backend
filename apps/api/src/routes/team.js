import { effectiveAddons } from '../../../../packages/entitlements/definitions.js';
import { scoped, collection } from '../../../../packages/database/store.js';
import { assertPermission, hasPermission, PERMISSIONS, canAccessWorkspace } from '../../../../packages/security/rbac.js';
import { inviteSchema } from '../../../../packages/validation/index.js';
import { hashToken } from '../../../../packages/security/encryption.js';
import { signInvite } from '../../../../packages/security/token.js';
import { newId } from '../../../../packages/shared/utils.js';
import { forbidden, badRequest, notFound, AppError } from '../../../../packages/shared/errors.js';
import { limitFor } from '../../../../packages/entitlements/definitions.js';
import { audit } from '../plugins/audit.js';

/** Plan + purchased add-ons. Buying the +5 seats pack must actually move the limit. */
const orgEntitlements = async ctx => {
  const org = await collection('organizations').findOne({ _id: ctx.organizationId });
  return { plan: org?.plan || (ctx.demo ? 'growth' : 'free'), addons: effectiveAddons(org) };
};

export default async function teamRoutes(app) {
  // Members are people, not uuids: resolve the user record so the table can show a
  // real name + email (and mark which row is you).
  app.get('/team/members', async req => {
    const rows = await scoped('memberships', req.ctx).find({});
    const ids = rows.map(r => r.userId).filter(Boolean);
    const users = ids.length ? await collection('users').find({ _id: { $in: ids } }) : [];
    const byId = new Map(users.map(u => [String(u._id), u]));
    return rows.map(m => {
      const u = byId.get(String(m.userId));
      const isYou = String(m.userId) === String(req.ctx.user.id);
      const email = m.email || u?.email || (isYou ? req.ctx.user.email : null) || `member-${String(m.userId).slice(0, 6)}@workspace`;
      const name = m.name || u?.name || email.split('@')[0].replace(/[._-]+/g, ' ');
      return { ...m, email, name, isYou, initials: (name || email).trim().slice(0, 2).toUpperCase() };
    });
  });

  app.post('/team/invite', async req => {
    assertPermission(req.ctx, PERMISSIONS.MEMBERS);
    // Trim first, then validate: people paste " Foo@Bar.com " and it is the same
    // person as "foo@bar.com" — it must pass, and must not create a second invite.
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : req.body?.email;
    const input = inviteSchema.parse({ ...(req.body || {}), email: rawEmail });
    const { plan, addons } = await orgEntitlements(req.ctx);
    const alreadyMember = await scoped('memberships', req.ctx).findOne({ email: input.email, status: { $in: ['active', 'invited'] } });
    if (alreadyMember) {
      throw new AppError(409, 'ALREADY_MEMBER',
        `${input.email} is already ${alreadyMember.status === 'invited' ? 'invited to' : 'part of'} this workspace.`);
    }
    const pendingInvite = await scoped('invitations', req.ctx).findOne({ email: input.email, status: 'pending' });
    if (pendingInvite) {
      throw new AppError(409, 'INVITE_PENDING', `An invite for ${input.email} is already waiting — resend that link instead of creating a new one.`);
    }
    const limit = limitFor(plan, 'seats', addons);
    const used = await scoped('memberships', req.ctx).countDocuments({ status: 'active' });
    if (limit >= 0 && used >= limit) {
      throw new AppError(402, 'SEAT_LIMIT', `Seat limit reached (${used}/${limit}). Buy the +5 seats add-on to invite more people.`);
    }
    const token = signInvite({ email: input.email, role: input.role, org: req.ctx.organizationId, workspaceId: input.workspaceId });
    const invite = await scoped('invitations', req.ctx).create({ _id: newId(), email: input.email, role: input.role,
      workspaceId: input.workspaceId || null, tokenHash: hashToken(token), status: 'pending', expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() });
    await audit(req.ctx, 'team.invite', 'invitation', { email: input.email, role: input.role });
    return { inviteId: invite._id, inviteUrl: `/invite?token=${token}`, expiresAt: invite.expiresAt };
  });

  app.post('/team/invite/accept', async req => {
    const { verifyInvite } = await import('../../../../packages/security/token.js');
    const data = verifyInvite(req.body.token);
    if (!data || data.email !== req.body.email) throw badRequest('Invalid invite');
    if (!data) throw badRequest('Invite link is invalid or expired');
    const invite = await scoped('invitations', req.ctx).findOne({ tokenHash: hashToken(req.body.token) });
    if (invite && invite.status !== 'pending') throw badRequest('This invite has already been used');
    if (invite && invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) throw badRequest('This invite has expired');
    await scoped('memberships', req.ctx).create({ _id: newId(), userId: req.ctx.user.id, organizationId: data.org,
      role: data.role, status: 'active', email: req.body.email || data.email || req.ctx.user.email,
      workspaceScopes: data.workspaceId ? [data.workspaceId] : [] });
    if (invite) await scoped('invitations', req.ctx).updateOne({ _id: invite._id }, { $set: { status: 'accepted' } });
    return { ok: true };
  });

  app.get('/team/invites', async req => scoped('invitations', req.ctx).find({ status: 'pending' }, { sort: { createdAt: -1 } }));

  app.delete('/team/invites/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.MEMBERS);
    await scoped('invitations', req.ctx).updateOne({ _id: req.params.id }, { $set: { status: 'revoked' } });
    return { ok: true };
  });

  app.patch('/team/members/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.MEMBERS);
    const m = await scoped('memberships', req.ctx).findOne({ _id: req.params.id });
    if (!m) throw badRequest('Membership not found');
    if (m.role === 'owner') throw forbidden('Owner role cannot be changed');
    await scoped('memberships', req.ctx).updateOne({ _id: m._id }, { $set: { role: req.body.role } });
    await audit(req.ctx, 'team.role_change', 'membership', { role: req.body.role });
    return { ok: true };
  });

  app.delete('/team/members/:id', async req => {
    assertPermission(req.ctx, PERMISSIONS.MEMBERS);
    await scoped('memberships', req.ctx).deleteOne({ _id: req.params.id });
    await audit(req.ctx, 'team.remove', 'membership', {});
    return { ok: true };
  });

  /** Owner/admin view of a member's devices — and a one-click force logout. */
  app.get('/team/members/:id/sessions', async req => {
    assertPermission(req.ctx, PERMISSIONS.MEMBERS);
    const rows = await collection('sessions').find({ userId: req.params.id, organizationId: req.ctx.organizationId,
      status: 'active' }, { sort: { createdAt: -1 }, limit: 100 });
    return rows.map(({ tokenHash, ...rest }) => ({
      ...rest, sid: rest._id, current: rest._id === req.ctx.sessionId,
      label: rest.userAgent || rest.device || 'Browser'
    }));
  });

  app.delete('/team/members/:id/sessions/:sid', async req => {
    assertPermission(req.ctx, PERMISSIONS.MEMBERS);
    const row = await collection('sessions').findOne({ _id: req.params.sid, userId: req.params.id,
      organizationId: req.ctx.organizationId });
    if (!row) throw notFound('Session not found');
    await collection('sessions').updateOne({ _id: row._id },
      { $set: { status: 'revoked', revokedAt: new Date().toISOString(), revokedReason: 'admin_force_logout' } });
    await audit(req.ctx, 'team.member.session_revoked', 'user', { userId: req.params.id, sessionId: row._id });
    return { ok: true };
  });

  app.post('/team/members/:id/logout', async req => {
    assertPermission(req.ctx, PERMISSIONS.MEMBERS);
    if (req.params.id === req.ctx.user.id) throw badRequest('Use the Security page to sign out of your own devices');
    const rows = await collection('sessions').find({ userId: req.params.id, organizationId: req.ctx.organizationId, status: 'active' });
    for (const row of rows) {
      await collection('sessions').updateOne({ _id: row._id },
        { $set: { status: 'revoked', revokedAt: new Date().toISOString(), revokedReason: 'admin_force_logout' } });
    }
    await audit(req.ctx, 'team.member.force_logout', 'user', { userId: req.params.id, sessions: rows.length });
    return { ok: true, revoked: rows.length };
  });

  app.get('/team/permissions', async req => ({ role: req.ctx.user.role, permissions: Object.values(PERMISSIONS)
    .filter(p => hasPermission(req.ctx.user.role, p)) }));

  app.post('/team/teams', async req => {
    assertPermission(req.ctx, PERMISSIONS.MEMBERS);
    const team = await scoped('teams', req.ctx).create({ _id: newId(), name: req.body.name, managerId: req.ctx.user.id,
      memberIds: req.body.memberIds || [] });
    return team;
  });
  app.get('/team/teams', async req => scoped('teams', req.ctx).find({}));
}
