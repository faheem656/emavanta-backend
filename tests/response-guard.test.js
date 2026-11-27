import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { errorPlugin } from '../apps/api/src/plugins/errors.js';

// A handler that returns nothing used to produce "200 OK" with a zero-byte
// body — the dashboard parsed it as {} and rendered empty lists/tables
// (contacts, campaigns, templates…). The onSend guard must always emit JSON.

test('2xx responses are never empty — undefined handlers serialize to {}', async () => {
  const app = Fastify();
  await app.register(errorPlugin);
  app.get('/api/v1/things', async () => ({ items: [1, 2] }));
  app.get('/api/v1/broken', async () => { /* returns undefined */ });
  app.get('/api/v1/bare', async () => {});

  const ok = await app.inject({ method: 'GET', url: '/api/v1/things' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, '{"items":[1,2]}');
  assert.match(ok.headers['content-type'] || '', /application\/json/);

  const broken = await app.inject({ method: 'GET', url: '/api/v1/broken' });
  assert.equal(broken.statusCode, 200);
  assert.equal(broken.body, '{}');
  assert.match(broken.headers['content-type'] || '', /application\/json/);

  const bare = await app.inject({ method: 'GET', url: '/api/v1/bare' });
  assert.equal(bare.statusCode, 200);
  assert.equal(bare.body, '{}');

  // Errors keep their structured envelope (the guard must not touch them).
  const missing = await app.inject({ method: 'GET', url: '/api/v1/nope' });
  assert.equal(missing.statusCode, 404);
  assert.equal(JSON.parse(missing.body).error.code, 'NOT_FOUND');
  await app.close();
});
