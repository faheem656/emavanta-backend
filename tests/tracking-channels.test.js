import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { testTrackingChannel, signPayload, TRACKING_METHODS } from '../apps/api/src/services/trackingChannels.js';
import { looksLikeBounce, extractBouncedEmails } from '../apps/api/src/workers/trackingPoller.js';
import { errorPlugin } from '../apps/api/src/plugins/errors.js';
import webhookRoutes from '../apps/api/src/routes/webhooks.js';
import trackingRoutes from '../apps/api/src/routes/tracking.js';
import { signLink } from '../packages/security/links.js';
import { scoped, collection } from '../packages/database/store.js';
import { hasPendingJob, closeQueues } from '../packages/queue/index.js';

test('channel tests reject bad input before any network call', async () => {
  await assert.rejects(() => testTrackingChannel('carrier-pigeon', {}), /Webhook, IMAP, POP3, Mail API or Hostinger/);
  await assert.rejects(() => testTrackingChannel('webhook', { secret: 'short' }), /at least 16 characters/);
  await assert.rejects(() => testTrackingChannel('imap', {}), /host, username and password/);
  await assert.rejects(() => testTrackingChannel('pop3', { host: 'x' }), /host, username and password/);
  await assert.rejects(() => testTrackingChannel('mailapi', { provider: 'ses', apiKey: 'k' }), /sendgrid, mailgun or postmark/);
  await assert.rejects(() => testTrackingChannel('mailapi', { provider: 'sendgrid' }), /API key/);
  await assert.rejects(() => testTrackingChannel('mailgun' && 'mailapi', { provider: 'mailgun', apiKey: 'k' }), /sending domain/);
  // Hostinger fails fast on missing inputs — no network call is made.
  await assert.rejects(() => testTrackingChannel('hostinger', {}), /Mail API token/);
  await assert.rejects(() => testTrackingChannel('hostinger', { token: 't'.repeat(20) }), /mailbox id missing/);
  await assert.rejects(() => testTrackingChannel('hostinger', { token: 't'.repeat(20), accountId: 'acc-test-123' }), /public HTTPS/);
  assert.deepEqual([...TRACKING_METHODS], ['webhook', 'imap', 'pop3', 'mailapi', 'hostinger']);
});

test('webhook channel test = real sign → verify round-trip', async () => {
  const secret = 'a'.repeat(40);
  const r = await testTrackingChannel('webhook', { secret });
  assert.equal(r.ok, true);
  assert.equal(r.secret, secret);
  // The signature the provider must send is reproducible.
  const payload = JSON.stringify({ event: 'bounce', email: 'x@y.test' });
  assert.equal(signPayload(payload, secret).length, 64);
});

test('DSN parsing: Final-Recipient + Status5 → the bounced address', () => {
  const dsn = [
    'From: Mail Delivery System <mailer-daemon@example.com>',
    'Subject: Undelivered Mail Returned to Sender',
    'To: sender@example.com',
    '',
    'This is the mail system at host example.com.',
    '',
    'Final-Recipient: rfc822; victim@company.test',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp;550 5.1.1 user unknown'
  ].join('\r\n');
  assert.equal(looksLikeBounce('Undelivered Mail Returned to Sender', 'mailer-daemon@example.com'), true);
  assert.deepEqual(extractBouncedEmails(dsn), ['victim@company.test']);
  // Plain "To:" extraction only kicks in for permanent failures.
  const plain = 'Subject: Warning: mail delivery failed\r\nTo: someone@corp.test\r\nhi';
  assert.equal(looksLikeBounce('Warning: mail delivery failed', ''), true);
  assert.deepEqual(extractBouncedEmails(plain), ['someone@corp.test']);
  // Non-bounce traffic never matches.
  assert.equal(looksLikeBounce('Weekly newsletter', 'hello@store.test'), false);
  assert.deepEqual(extractBouncedEmails('hello, just a normal note to you@x.test'), []);
});

test('per-account inbound webhook: signature gates the queue, test events ping only', async () => {
  const app = Fastify();
  await app.register(errorPlugin);
  await app.register(webhookRoutes);
  const orgId = `org-wh-${Date.now()}`;
  const accountId = `acc-wh-${Date.now()}`;
  const secret = 's'.repeat(32);
  await scoped('sending_accounts', { organizationId: orgId }).create({
    _id: accountId, organizationId: orgId, fromEmail: 'sender@x.test', status: 'active',
    tracking: { method: 'webhook', status: 'verified', secret, webhookPath: `/api/v1/webhooks/mailbox/${accountId}` }
  });

  const post = (body, sig) => app.inject({
    method: 'POST', url: `/webhooks/mailbox/${accountId}`,
    headers: { 'content-type': 'application/json', 'x-webhook-signature': sig || '' },
    payload: JSON.stringify(body)
  });

  // Wrong signature → rejected.
  const bad = await post({ event: 'bounce', email: 'a@b.test' }, 'f'.repeat(64));
  assert.equal(bad.statusCode, 400);

  // Test ping → accepted, but nothing enters the queue.
  const ping = await post({ test: true, event: 'tracking_test' }, signPayload(JSON.stringify({ test: true, event: 'tracking_test' }), secret));
  assert.equal(ping.statusCode, 200);
  assert.equal(JSON.parse(ping.body).accepted, 0);

  // Real bounce → accepted AND queued for the shared processor.
  const jobId = `wh-test-${Date.now()}`;
  const bounceBody = { event: 'bounce', email: 'victim@company.test', id: jobId };
  const ok = await post(bounceBody, signPayload(JSON.stringify(bounceBody), secret));
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).accepted, 1);
  assert.equal(await hasPendingJob('webhook', jobId), true);

  // Unknown mailbox → rejected (different URL, valid signature for its body).
  const orphanBody = { event: 'bounce', email: 'a@b.test' };
  const missing = await app.inject({
    method: 'POST', url: `/webhooks/mailbox/acc-does-not-exist-${Date.now()}`,
    headers: { 'content-type': 'application/json', 'x-webhook-signature': signPayload(JSON.stringify(orphanBody), secret) },
    payload: JSON.stringify(orphanBody)
  });
  assert.equal(missing.statusCode >= 400, true);

  await app.close();
  await closeQueues();
});

test('hostinger receiver: Bearer secret gates delivery and wakes the inbound poller', async () => {
  const app = Fastify();
  await app.register(errorPlugin);
  await app.register(webhookRoutes);
  const orgId = `org-hm-${Date.now()}`;
  const accountId = `acc-hm-${Date.now()}`;
  const secret = 'h'.repeat(48);
  await scoped('sending_accounts', { organizationId: orgId }).create({
    _id: accountId, organizationId: orgId, fromEmail: 'hm@x.test', status: 'active',
    tracking: { method: 'hostinger', status: 'verified', secret,
      webhookPath: `/api/v1/webhooks/mailbox/${accountId}`, lastPolledAt: new Date().toISOString() }
  });
  const post = headers => app.inject({
    method: 'POST', url: `/webhooks/mailbox/${accountId}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({ event: 'message.received', mailbox: 'hm@x.test',
      message: { from: 'mailer-daemon@x.test', subject: 'Undelivered Mail Returned to Sender' } })
  });
  // Wrong bearer → rejected. No auth → rejected.
  assert.equal((await post({ authorization: `Bearer ${'x'.repeat(48)}` })).statusCode, 400);
  assert.equal((await post({})).statusCode, 400);
  // Correct bearer → 200 + the poller is woken for the ≤30 s sweep.
  const ok = await post({ authorization: `Bearer ${secret}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).received, true);
  const acc = await scoped('sending_accounts', { organizationId: orgId }).findOne({ _id: accountId });
  assert.equal(acc.tracking.lastPolledAt, null);
  await app.close();
  await closeQueues();
});

test('unsubscribe is also counted as an open and marks the contact', async () => {
  // Same router limits as server.js — unsubscribe tokens are long signed links.
  const app = Fastify({ routerOptions: { maxParamLength: 2048 } });
  await app.register(errorPlugin);
  await app.register(trackingRoutes);
  const orgId = `org-un-${Date.now()}`;
  const campaignId = `camp-un-${Date.now()}`;
  const email = `unsub-${Date.now()}@x.test`;
  await collection('campaigns').create({ _id: campaignId, organizationId: orgId, stats: {} });
  await collection('contacts').create({ _id: `ct-un-${Date.now()}`, organizationId: orgId, email, listIds: [], status: 'active' });
  const token = signLink({ kind: 'u', org: orgId, email, campaignId, messageId: `msg-un-${Date.now()}` });
  const res = await app.inject({
    method: 'POST', url: `/u/${token}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'choice=campaign'
  });
  assert.equal(res.statusCode, 200);
  const events = await collection('delivery_events').find({ organizationId: orgId });
  assert.deepEqual(events.map(e => e.type).sort(), ['opened', 'unsubscribed']);
  const camp = await collection('campaigns').findOne({ _id: campaignId });
  assert.equal(camp.stats.unsubscribed, 1);
  assert.equal(camp.stats.opened, 1); // the unsubscribe counts as an open, exactly once
  const ct = await collection('contacts').findOne({ organizationId: orgId, email });
  assert.ok(ct.lastOpenedAt, 'contact must be marked as opened');
  assert.equal(ct.status, 'unsubscribed');
  // Second POST (double click) must not inflate anything.
  await app.inject({ method: 'POST', url: `/u/${token}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'choice=campaign' });
  const camp2 = await collection('campaigns').findOne({ _id: campaignId });
  assert.equal(camp2.stats.opened, 1);
  assert.equal(camp2.stats.unsubscribed, 1);
  await app.close();
  await closeQueues();
});
