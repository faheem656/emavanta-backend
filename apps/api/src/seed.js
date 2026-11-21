import { collection, connectDB } from '../../../packages/database/store.js';
import { newId } from '../../../packages/shared/utils.js';

export const seedDemoData = async () => {
if(process.env.NODE_ENV!=='test'||process.env.DEMO_MODE!=='true'||process.env.MONGODB_URI)throw new Error('Demo seeding is permitted only in isolated in-memory tests.');
await connectDB();
const org = 'demo-org';
const now = new Date().toISOString();
const ensure = async (name, filter, doc) => { if (!(await collection(name).findOne(filter))) await collection(name).create({ _id: newId(), ...doc, ...filter }); };

await ensure('organizations', { _id: org }, { name: 'Demo Org', plan: 'growth', cycle: 'demo-cycle', settings: {} });
await ensure('templates', { _id: 'demo-template' }, { organizationId: org, name: 'Welcome', subject: 'Hi {{first_name|there}} from {{sender_name|the team}}',
  mode: 'blocks', version: 1, status: 'published',
  blocks: [{ type: 'heading', content: 'Hello {{first_name|there}}' },
    { type: 'text', content: 'A personal note for {{company|your company}}.' },
    { type: 'unsubscribe', content: '' }, { type: 'address', content: 'Demo Address, Vilnius, LT' }] });
for (let i = 1; i <= 12; i++) {
  await ensure('contacts', { email: `lead${i}@example.com` }, { organizationId: org, firstName: `Lead${i}`, company: `Company ${i}`,
    listIds: ['demo-list'], customFields: {} });
}
await ensure('contact_lists', { _id: 'demo-list' }, { organizationId: org, name: 'Demo leads' });

// People, not ids: the team table must always be able to show a name and an email.
await ensure('users', { _id: 'demo-user' }, { email: 'owner@emavanta.com', name: 'Dana Nguyen',
  emailVerified: true, mfaEnabled: false, createdAt: now });
for (const u of [
  { _id: 'demo-user-leo', email: 'leo@northwind.com', name: 'Leo Park' },
  { _id: 'demo-user-maya', email: 'maya@northwind.com', name: 'Maya Silva' }
]) await ensure('users', { _id: u._id }, { ...u, emailVerified: true, mfaEnabled: false, createdAt: now });
await ensure('memberships', { _id: 'demo-membership' }, { organizationId: org, userId: 'demo-user',
  role: 'owner', status: 'active', email: 'owner@emavanta.com', name: 'Dana Nguyen', workspaceScopes: [], createdAt: now });
await ensure('memberships', { _id: 'demo-membership-leo' }, { organizationId: org, userId: 'demo-user-leo',
  role: 'admin', status: 'active', email: 'leo@northwind.com', name: 'Leo Park', workspaceScopes: [], createdAt: now });
await ensure('memberships', { _id: 'demo-membership-maya' }, { organizationId: org, userId: 'demo-user-maya',
  role: 'member', status: 'invited', email: 'maya@northwind.com', name: 'Maya Silva',
  tokenHash: 'seeded-invite', workspaceScopes: [], createdAt: now });
await ensure('sending_accounts', { _id: 'demo-account' }, { organizationId: org, authMethod: 'mock', status: 'active',
  stream: 'outreach', fromEmail: '.owner@demo.example', fromName: 'Demo Owner', dailyCap: 50, sentToday: 0,
  encryptedCredentials: 'v1:demo', warmup: false });
await ensure('campaigns', { _id: 'demo-campaign' }, { organizationId: org, name: 'Demo outreach', status: 'draft',
  stream: 'outreach', listIds: ['demo-list'], templateId: 'demo-template', accountPool: ['demo-account'],
  rotation: 'sticky_by_contact', sendPolicy: { minDelaySec: 45, maxDelaySec: 90, jitterPct: 20, dailyCap: 50 },
  stats: { queued: 0, sent: 0, delivered: 0, bounced: 0, replied: 0 } });
console.log('[seed] demo data ready');
};

if (process.argv[1]?.endsWith('seed.js')) await seedDemoData();
