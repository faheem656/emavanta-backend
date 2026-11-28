/**
 * Role-based addresses (info@, support@…) are real mailboxes but role inboxes:
 * they receive mail, rarely engage, and often sit behind catch-all policies.
 * Flagged RISKY — never INVALID (they do receive).
 */
const ROLES = new Set([
  'info', 'admin', 'administrator', 'support', 'sales', 'contact', 'hello', 'help', 'office',
  'postmaster', 'abuse', 'webmaster', 'hostmaster', 'noreply', 'no-reply', 'donotreply',
  'marketing', 'team', 'billing', 'accounts', 'jobs', 'careers', 'press', 'service',
  'feedback', 'newsletter', 'mail', 'inbox', 'root', 'security', 'privacy', 'legal', 'hr'
]);

export const isRoleAccount = local => ROLES.has(String(local || '').toLowerCase());
export const ROLE_LIST = ROLES;
