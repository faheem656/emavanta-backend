import { ROLE_PERMISSIONS, PERMISSIONS } from '../shared/constants.js';
import { forbidden } from '../shared/errors.js';
export const hasPermission = (role, permission, scope) => {
  const list = ROLE_PERMISSIONS[role] || [];
  if (!list.includes(permission)) return false;
  if (scope === 'billing' && role !== 'owner' && role !== 'billing') return false;
  return true;
};
export const assertPermission = (ctx, permission, scope) => {
  if (!hasPermission(ctx?.user?.role, permission, scope)) throw forbidden(`Missing ${permission}`);
};
export const canAccessWorkspace = (ctx, workspaceId) => {
  if (!workspaceId) return true;
  if (ctx.user.role === 'owner' || ctx.user.role === 'admin' || ctx.user.role === 'super_admin') return true;
  return (ctx.user.workspaceScopes || []).includes(workspaceId);
};
export { PERMISSIONS };
