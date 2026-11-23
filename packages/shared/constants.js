export const STREAMS = Object.freeze({
  TRANSACTIONAL: 'transactional',
  MARKETING: 'marketing',
  OUTREACH: 'outreach'
});

export const ROLES = Object.freeze({
  OWNER: 'owner', ADMIN: 'admin', MEMBER: 'member',
  VIEWER: 'viewer', BILLING: 'billing', CLIENT: 'client', SUPER_ADMIN: 'super_admin'
});

export const PERMISSIONS = Object.freeze({
  ORG_SETTINGS: 'org:settings',
  MEMBERS: 'members:manage',
  BILLING: 'billing:manage',
  CONTACTS_WRITE: 'contacts:write',
  CAMPAIGNS_WRITE: 'campaigns:write',
  CAMPAIGNS_SEND: 'campaigns:send',
  ACCOUNTS_CONNECT: 'accounts:connect',
  INBOX_WRITE: 'inbox:write',
  ANALYTICS_READ: 'analytics:read',
  TEMPLATES_WRITE: 'templates:write',
  CLIENT_WORKSPACES: 'clients:manage',
  AUDIT_READ: 'audit:read'
});

export const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.values(PERMISSIONS),
  admin: Object.values(PERMISSIONS).filter(p => p !== PERMISSIONS.BILLING),
  member: [
    PERMISSIONS.CONTACTS_WRITE, PERMISSIONS.CAMPAIGNS_WRITE,
    PERMISSIONS.CAMPAIGNS_SEND, PERMISSIONS.INBOX_WRITE,
    PERMISSIONS.ANALYTICS_READ, PERMISSIONS.TEMPLATES_WRITE
  ],
  viewer: [PERMISSIONS.ANALYTICS_READ],
  billing: [PERMISSIONS.BILLING],
  client: [
    PERMISSIONS.CONTACTS_WRITE, PERMISSIONS.CAMPAIGNS_WRITE,
    PERMISSIONS.CAMPAIGNS_SEND, PERMISSIONS.INBOX_WRITE,
    PERMISSIONS.ANALYTICS_READ, PERMISSIONS.TEMPLATES_WRITE
  ],
  super_admin: []
});

export const ACCOUNT_STATUS = Object.freeze({
  CONNECTING: 'connecting', VERIFYING: 'verifying', ACTIVE: 'active',
  LIMITED: 'limited', PAUSED: 'paused', REAUTH_REQUIRED: 'reauth_required', REVOKED: 'revoked'
});

export const RECIPIENT_STATUS = Object.freeze({
  QUEUED: 'queued', SENDING: 'sending', SENT: 'sent', DELIVERED: 'delivered',
  BOUNCED: 'bounced', COMPLAINED: 'complained', DEFERRED: 'deferred', FAILED: 'failed', PAUSED: 'paused'
});

export const ROTATION = Object.freeze({
  ROUND_ROBIN: 'round_robin', WEIGHTED: 'weighted', LEAST_USED: 'least_used',
  RANDOM_JITTER: 'random_jitter', STICKY_BY_CONTACT: 'sticky_by_contact'
});

export const QUEUE_NAMES = Object.freeze([
  'outbox', 'campaign', 'campaign_intake', 'outreach', 'marketing', 'transactional',
  'webhook', 'webhook_out', 'contact_mail', 'analytics', 'report', 'import', 'billing', 'scheduler', 'reconcile', 'automation'
]);
