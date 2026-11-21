import { collection } from '../../../packages/database/store.js';
import { forbidden } from '../../../packages/shared/errors.js';

// Platform access is never derived from a tenant role, a request body, or an API key.
// The configured owner must have a verified account and a valid signed-in session.
export async function platformOwnerAccess(ctx) {
  const email = String(process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
  const jwtSecret = String(process.env.JWT_SECRET || '');
  if (jwtSecret.length < 32 || /demo-jwt-secret|change[-_ ]?me|replace[-_ ]?me/i.test(jwtSecret)) return { owner: false, ready: false };
  if (!email || !ctx?.user?.id || !ctx?.sessionId || ctx.demo || ctx.apiKeyId) return { owner: false, ready: false };
  const user = await collection('users').findOne({ _id: ctx.user.id });
  const session = await collection('sessions').findOne({ _id: ctx.sessionId, userId: ctx.user.id, organizationId: ctx.organizationId, status: 'active' });
  if (!user || user.emailVerified !== true || String(user.email || '').trim().toLowerCase() !== email || !session || (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now())) return { owner: false, ready: false };
  return { owner: true, ready: user.mfaEnabled === true && session.mfaVerified === true };
}
export async function requirePlatformOwner(ctx) {
  const access = await platformOwnerAccess(ctx);
  if (!access.owner) throw forbidden('Platform owner access required.');
  if (!access.ready) throw forbidden('Enable two-factor authentication and sign in again with your authenticator to access platform administration.');
  return access;
}
