/**
 * Personalization must be trustworthy:
 *  - snake_case tokens ({{first_name}}) resolve to camelCase contact fields —
 *    the API advertises first_name, so "Hi {{first_name|there}}" has to greet
 *    Ayesha by name, not fall back to "there";
 *  - a pipe fallback applies ONLY when the value is missing;
 *  - subjects stay plain text (O'Brien, not O&#39;Brien);
 *  - raw CSV/API rows (first_name, Job Title…) are normalized like the UI import.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveToken, renderText, extractTokens } from '../packages/email-engine/personalization.js';
import { normalizeContactRow } from '../packages/validation/index.js';

test('snake_case tokens resolve to camelCase contact fields', () => {
  const ctx = { firstName: 'Ayesha', lastName: 'Khan', company: 'ACME' };
  assert.equal(renderText('Hi {{first_name|there}}!', ctx), 'Hi Ayesha!');
  assert.equal(renderText('Hi {{last_name|there}}!', ctx), 'Hi Khan!');
  assert.equal(renderText('{{company|your team}}', ctx), 'ACME');
  assert.equal(renderText('{{first_name}}', ctx), 'Ayesha');
});

test('the pipe fallback applies only when the value is missing', () => {
  assert.equal(renderText('Hi {{first_name|there}}!', { firstName: '' }), 'Hi there!');
  assert.equal(renderText('Hi {{first_name|there}}!', {}), 'Hi there!');
  assert.equal(renderText('Hi {{first_name}}!', {}), 'Hi !');
  assert.equal(renderText('{{company|your team}}', { company: 'Zap' }), 'Zap');
});

test('custom fields and registry fallbacks participate; pipe wins', () => {
  const ctx = { customFields: { industry_sector: 'SaaS' }, tokenFallbacks: { nickname: 'friend' } };
  assert.equal(renderText('{{industry_sector|tech}}', ctx), 'SaaS');
  assert.equal(renderText('{{nickname}}', ctx), 'friend');
  assert.equal(renderText('{{nickname|buddy}}', ctx), 'buddy');
});

test('conditionals honour aliases', () => {
  assert.equal(renderText('{{#if first_name}}Hi {{first_name}}{{else}}Hello{{/if}}', { firstName: 'Ali' }), 'Hi Ali');
  assert.equal(renderText('{{#if first_name}}Hi{{else}}Hello{{/if}}', {}), 'Hello');
});

test('subjects are plain text; HTML bodies are escaped', () => {
  const ctx = { firstName: "O'Brien & Co" };
  assert.equal(renderText('Hi {{first_name}}', ctx, { html: false }), "Hi O'Brien & Co");
  assert.equal(renderText('Hi {{first_name}}', ctx), 'Hi O&#39;Brien &amp; Co');
  assert.equal(resolveToken('first_name', ctx, undefined, { html: false }), "O'Brien & Co");
});

test('normalizeContactRow maps snake columns and keeps custom columns', () => {
  const n = normalizeContactRow({ email: 'a@b.c', first_name: 'Sara', last_name: 'Ali',
    organization: 'Fintech Labs', industry: 'Fintech', 'Job Title': 'CEO', listIds: ['l1'] });
  assert.equal(n.firstName, 'Sara');
  assert.equal(n.lastName, 'Ali');
  assert.equal(n.company, 'Fintech Labs');
  assert.equal(n.customFields.industry, 'Fintech');
  assert.equal(n.customFields.job_title, 'CEO');
  assert.deepEqual(n.listIds, ['l1'], 'schema fields are untouched');
});

test('extractTokens reports snake tokens for preflight', () => {
  assert.deepEqual(extractTokens('Hi {{first_name|there}}, {{company}}'), ['first_name', 'company']);
});

test('renderMessage personalizes the real send from the CONTACT record', async () => {
  const { renderMessage } = await import('../packages/email-engine/render.js');
  const msg = renderMessage({
    template: { mode: 'code', html: '<p>Hi {{first_name}} — {{city}}</p>', subject: 'Hello {{first_name}} from {{company}}' },
    recipient: { _id: 'r1', email: 'dana@x.test' }, // recipient row: address only
    contact: { firstName: 'Dana', lastName: 'Smith', company: 'Acme Co', customFields: { city: 'Karachi' } },
    account: { _id: 'a1', fromEmail: 'sales@x.test', fromName: 'Sales' },
    campaign: { _id: 'c1' }, organizationId: 'o1', tokenFallbacks: {}
  });
  assert.equal(msg.subject, 'Hello Dana from Acme Co');
  assert.match(msg.html, /Hi Dana — Karachi/);
  assert.equal(msg.to, 'dana@x.test');
});

test('renderMessage falls back to registry defaults when the contact lacks the field', async () => {
  const { renderMessage } = await import('../packages/email-engine/render.js');
  const msg = renderMessage({
    template: { mode: 'code', html: '<p>Hi {{first_name}}</p>', subject: 'Hi {{first_name}}' },
    recipient: { _id: 'r2', email: 'x@x.test' },
    contact: { email: 'x@x.test' },
    account: { _id: 'a1', fromEmail: 's@x.test', fromName: 'S' },
    campaign: { _id: 'c2' }, organizationId: 'o1', tokenFallbacks: { first_name: 'there' }
  });
  assert.equal(msg.subject, 'Hi there');
});
