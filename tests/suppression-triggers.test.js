/**
 * Round-9 guards:
 *  - intake NEVER queues an unsubscribed / bounced / suppressed contact: the row
 *    is stored PAUSED with the exact reason, and a "skipped" delivery event
 *    names that reason in the per-lead stream of the campaign,
 *  - a queued event exists only for contacts that will actually be attempted,
 *  - "Email is opened" sequences fire only for contacts on the sequence's list.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
delete process.env.MONGODB_URI; // in-memory store

const { collection, scoped } = await import('../packages/database/store.js');
const { closeQueues } = await import('../packages/queue/index.js');
const { intakeChunk } = await import('../packages/scale/intake.js');
const { recordAutomationTriggers } = await import('../packages/automations/triggers.js');

const ORG = 'org-supp';
const ctx = { organizationId: ORG };
after(async () => { await closeQueues(); });

test('intake pauses unsubscribed/bounced/suppressed contacts with the reason', async () => {
  await collection('organizations').create({ _id: ORG, name: 'Supp', plan: 'growth' });
  const mk = (id, email, status = 'subscribed') =>
    scoped('contacts', ctx).create({ _id: id, email, status, listIds: ['list-1'], firstName: 'X' });
  await mk('c-clean', 'clean@x.test');
  await mk('c-unsub', 'unsub@x.test', 'unsubscribed');
  await mk('c-bounced', 'bounced@x.test', 'bounced');
  await mk('c-supp', 'supp@x.test'); // clean status — the suppression row bans it
  await scoped('suppressions', ctx).create({ _id: 'sup-1', email: 'supp@x.test', reason: 'bounced', status: 'active' });
  await scoped('campaigns', ctx).create({ _id: 'camp-s', status: 'queued', listIds: ['list-1'], stream: 'marketing' });

  await intakeChunk({ organizationId: ORG, campaignId: 'camp-s', listIds: ['list-1'],
    stream: 'marketing', accountPool: ['acc-1'], rotation: 'round_robin',
    sendPolicy: { minDelaySec: 45, maxDelaySec: 90, dailyCap: 50 } });

  const rows = await scoped('campaign_recipients', ctx).find({ campaignId: 'camp-s' });
  const byEmail = Object.fromEntries(rows.map(r => [r.email, r]));
  assert.equal(rows.length, 4);
  assert.equal(byEmail['clean@x.test'].status, 'queued');
  assert.equal(byEmail['unsub@x.test'].status, 'paused');
  assert.equal(byEmail['unsub@x.test'].reason, 'unsubscribed');
  assert.equal(byEmail['bounced@x.test'].status, 'paused');
  assert.equal(byEmail['bounced@x.test'].reason, 'already_bounced');
  assert.equal(byEmail['supp@x.test'].status, 'paused');
  assert.equal(byEmail['supp@x.test'].reason, 'already_bounced');

  const events = await scoped('delivery_events', ctx).find({ campaignId: 'camp-s' });
  const skipped = events.filter(e => e.type === 'skipped');
  assert.equal(skipped.length, 3, 'one skipped event per suppressed lead');
  assert.ok(skipped.some(e => e.email === 'unsub@x.test' && e.note === 'unsubscribed'));
  assert.ok(skipped.some(e => e.email === 'bounced@x.test' && e.note === 'already_bounced'));
  assert.ok(!events.some(e => e.type === 'queued' && e.email === 'unsub@x.test'),
    'a paused lead never gets a queued event');
  assert.ok(events.some(e => e.type === 'queued' && e.email === 'clean@x.test'));

  // A re-run (pause → Launch again) must be a no-op for rows and events.
  await intakeChunk({ organizationId: ORG, campaignId: 'camp-s', listIds: ['list-1'],
    stream: 'marketing', accountPool: ['acc-1'], rotation: 'round_robin',
    sendPolicy: { minDelaySec: 45, maxDelaySec: 90, dailyCap: 50 } });
  const rows2 = await scoped('campaign_recipients', ctx).find({ campaignId: 'camp-s' });
  assert.equal(rows2.length, 4, 're-running the chunk does not duplicate recipients');
  const events2 = await scoped('delivery_events', ctx).find({ campaignId: 'camp-s' });
  assert.equal(events2.filter(e => e.type === 'skipped').length, 3, 'no duplicate skipped events');
  assert.equal(events2.filter(e => e.type === 'queued').length, 1, 'no duplicate queued events');
});

test('email_opened trigger fires only for contacts on the sequence list', async () => {
  await scoped('sequences', ctx).create({ _id: 'seq-open', name: 'On open', trigger: 'email_opened',
    listId: 'list-1', status: 'active', executionEnabled: true,
    steps: [{ type: 'email', templateId: 'tpl-1' }] });

  const on = await recordAutomationTriggers({ organizationId: ORG, trigger: 'email_opened',
    contactId: 'c-clean', listIds: ['list-1'] });
  assert.equal(on.queued, 1, 'contact on the list matches');

  const off = await recordAutomationTriggers({ organizationId: ORG, trigger: 'email_opened',
    contactId: 'c-other', listIds: ['list-elsewhere'] });
  assert.equal(off.queued, 0, 'contact off the list does not match');
});
