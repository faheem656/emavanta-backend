import fp from 'fastify-plugin';
import { verifySession } from '../../../../packages/security/token.js';
import { hashToken } from '../../../../packages/security/encryption.js';
import { collection, isMemoryMode } from '../../../../packages/database/store.js';
import { expireCryptoSubscription } from '../payments/crypto-service.js';
import { ROLES } from '../../../../packages/shared/constants.js';
import { unauthorized } from '../../../../packages/shared/errors.js';
import { sessionNotExpired } from '../../../../packages/security/session-validity.js';

export const contextPlugin = fp(async app => {
  app.decorateRequest('ctx', null);
  app.addHook('onRequest', async req => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const payload = verifySession(auth.slice(7));
      if (payload) {
        if (!payload.sid) throw unauthorized('Sign in again to continue.');
        const account = await collection('users').findOne({ _id: payload.sub });
        if (!account && !(process.env.DEMO_MODE === 'true' && process.env.NODE_ENV === 'test' && payload.sub === 'demo-user')) throw unauthorized('Sign in again to continue.');
        if (['suspended','deleted'].includes(account?.platformStatus)) throw unauthorized('This account is not active. Contact support.');
        if (account?.emailVerified === false) throw unauthorized('Verify your email before accessing your workspace.');
        // A token is only good while its session is alive — that is what makes
        // "sign out", "sign out everywhere" and an admin force-logout real.
        if (payload.sid) {
          const session = await collection('sessions').findOne({ _id: payload.sid });
          const withinLifetime = sessionNotExpired(session);
          if (session?.status === 'active' && !withinLifetime) {
            await collection('sessions').updateOne({ _id: payload.sid, status: 'active' },
              { $set: { status: 'expired', expiredAt: new Date().toISOString(), revokedReason: 'ttl_expired' } });
          }
          // A signed-out or expired session must answer 401 with a sentence the UI can show, not a
          // generic 500. The client removes its bearer token after this explicit 401.
          if (!session || session.status !== 'active' || session.userId !== payload.sub ||
              session.organizationId !== payload.org || !withinLifetime) {
            throw unauthorized('This session has expired or was signed out. Sign in again.');
          }
        }
        if (!(process.env.NODE_ENV === 'test' && payload.sub === 'demo-user')) {
          const membership = await collection('memberships').findOne({ _id: payload.membershipId, userId: payload.sub, organizationId: payload.org, status: 'active' });
          if (!membership) throw unauthorized('Your workspace membership is no longer active.');
          payload.role = membership.role;
          payload.workspaceScopes = membership.workspaceScopes || [];
        }
        if (!isMemoryMode() && payload.org) await expireCryptoSubscription(payload.org);
        req.ctx = {
          user: { id: payload.sub, email: payload.email, role: payload.role, workspaceScopes: payload.workspaceScopes || [] },
          organizationId: payload.org,
          membershipId: payload.membershipId,
          sessionId: payload.sid || null,
          demo: payload.sub === 'demo-user' && payload.org === 'demo-org'
        };
        return;
      }
    }
    if (req.headers['x-api-key']) {
      const key = await collection('api_keys').findOne({ tokenHash: hashToken(req.headers['x-api-key']), status: 'active' });
      if (key && (!key.expiresAt || Date.parse(key.expiresAt) > Date.now())) {
        const apiUser=await collection('users').findOne({_id:key.createdBy});
        if (!apiUser || ['suspended','deleted'].includes(apiUser.platformStatus)) throw unauthorized('This account is not active. Contact support.');
        const ipOk = !(key.ipAllowlist || []).length || (key.ipAllowlist || []).includes(req.ip);
        if (ipOk) {
          const membership = await collection('memberships').findOne({ userId: key.createdBy, status: 'active' });
          if (membership) {
            if (!isMemoryMode()) await expireCryptoSubscription(membership.organizationId);
            req.ctx = { user: { id: key.createdBy, role: membership.role, email: 'api-key', workspaceScopes: membership.workspaceScopes || [] },
              organizationId: membership.organizationId, apiKeyScopes: key.scopes, apiKeyId: key._id };
            return;
          }
        }
      }
    }
    if (process.env.DEMO_MODE === 'true' && process.env.NODE_ENV === 'test') {
      req.ctx = {
        user: { id: 'demo-user', email: 'demo@emavanta.local', role: ROLES.OWNER, workspaceScopes: [] },
        organizationId: 'demo-org',
        demo: true
      };
      return;
    }
    const path = req.url.split('?')[0].replace(/^\/api\/v1/, '');
    const publicPaths = new Set(['/health', '/health/scale', '/ready', '/billing/plans', '/contact',
      '/auth/register', '/auth/login', '/auth/login/mfa', '/auth/verify-otp', '/auth/verify-otp/resend',
      '/auth/password/forgot', '/auth/password/reset/check', '/auth/password/reset', '/accounts/oauth/callback']);
    if (publicPaths.has(path) || /^\/public\/forms\//.test(path) || /^\/webhooks\//.test(path) || /^\/(u|t)\//.test(path)) return;
    throw unauthorized('Sign in to continue.');
  });
});
