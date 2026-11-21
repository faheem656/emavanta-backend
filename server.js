import './apps/api/src/env.js'; // must stay first: loads .env before anything reads process.env
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './apps/api/src/config.js';
import { contextPlugin } from './apps/api/src/plugins/context.js';
import { errorPlugin } from './apps/api/src/plugins/errors.js';
import { installJsonParser } from './apps/api/src/plugins/json-body.js';
import { connectDB, disconnectDB } from './packages/database/store.js';
import { startWorkers } from './apps/api/src/workers/index.js';
import { startSchedulerSweep } from './apps/api/src/workers/schedulerSweep.js';
import { closeQueues, getQueue } from './packages/queue/index.js';

// Trust only explicitly configured reverse-proxy addresses/CIDRs; never trust arbitrary X-Forwarded-For.
const trustedProxy=String(process.env.TRUSTED_PROXY_IPS||'').split(',').map(x=>x.trim()).filter(Boolean);
const app = Fastify({ ...(trustedProxy.length?{trustProxy:trustedProxy}:{}), routerOptions: { maxParamLength: 2048 }, logger: { level: process.env.LOG_LEVEL || 'warn' }, requestIdHeader: 'x-request-id' });
await app.register(cors, { origin: true, credentials: true });

// Browsers/proxies sometimes send `content-type: application/json` with an empty body
// (e.g. a bodyless DELETE). Treat that as {} instead of a 400 so the action still works.
installJsonParser(app);
await app.register(errorPlugin);
await app.register(contextPlugin);

const routes = [
  ['/api/v1', (await import('./apps/api/src/routes/health.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/auth.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/organizations.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/team.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/contacts.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/templates.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/accounts.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/campaigns.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/sequences.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/analytics.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/billing.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/crypto.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/stripe-elements.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/admin.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/webhooks.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/advanced.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/advanced2.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/advanced3.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/advanced4.js')).default],
  ['/api/v1', (await import('./apps/api/src/routes/forms.js')).default]
];
for (const [prefix, plugin] of routes) await app.register(plugin, { prefix });
await app.register((await import('./apps/api/src/routes/tracking.js')).default);

const dbState = await connectDB().catch(err => {
  console.error(`\n[api] startup aborted — ${err.message}\n`);
  process.exit(1);
});
console.log(`[api] storage: ${dbState.mode}${dbState.database ? ` · ${dbState.database}` : ''}`);
if (config.demo) { const { seedDemoData } = await import('./apps/api/src/seed.js'); await seedDemoData(); }
const embeddedWorkers=process.env.RUN_EMBEDDED_WORKERS!=='false';
if(embeddedWorkers)startWorkers();
const stopSchedulerSweep=embeddedWorkers?startSchedulerSweep():async()=>{};
if(!embeddedWorkers)console.log('[api] embedded workers disabled; run dedicated worker processes.');
// Long-horizon jobs live in Mongo; a lightweight poller dispatches due rows.
// In production this is a cron/leader-elected job; in demo we kick it at boot.
if (config.demo && embeddedWorkers) getQueue('scheduler').add('scheduler.poll', { organizationId: 'demo-org', poll: true },
  { jobId: 'scheduler-poll-demo', dedupe: false });

try {
  await app.listen({ port: config.port, host: config.host });
  const routes = app.printRoutes({ commonPrefix: false });
  const routeCount = String(routes).split('\n').filter(l => l.includes('(')).length;
  console.log(`[api] listening on http://localhost:${config.port}/api/v1/health (${config.demo ? 'demo' : 'full'} mode) · ${routeCount} routes · storage=${dbState.mode}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

const shutdown = async () => {
  await app.close();
  await stopSchedulerSweep();
  await closeQueues();
  await disconnectDB();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
