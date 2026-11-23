import { getQueue } from '../../../../packages/queue/index.js';
import { readFileSync } from 'node:fs';
import { dbInfo, pingDB } from '../../../../packages/database/store.js';

// Bumped whenever the dashboard starts depending on new API routes, so the web app
// can tell the difference between "backend down" and "backend too old".
export const API_SCHEMA = 12;

const pkg = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')); }
  catch { return { version: '0.1.0' }; }
})();

const startedAt = new Date().toISOString();

export default async function healthRoutes(app) {
  app.get('/health', async () => {
    const db = dbInfo();
    return { ok: true, service: 'api', schema: API_SCHEMA, version: pkg.version,
      mode: process.env.DEMO_MODE === 'true' ? 'demo' : 'full',
      storage: db.driver, db: { driver: db.driver, connected: db.connected, database: db.database,
        host: db.host, srv: db.srv },
      uptime: process.uptime(), startedAt, now: new Date().toISOString() };
  });
  /**
   * Scale snapshot: memory, event-loop lag and backlog per queue. The load simulation
   * samples this — it is the honest answer to "will millions of sends crash us?".
   */
  app.get('/health/scale', async () => {
    const mem = process.memoryUsage();
    const queues = {};
    for (const name of ['outbox', 'campaign', 'campaign_intake', 'outreach']) {
      queues[name] = await getQueue(name).getJobCounts().catch(() => null);
    }
    const lag = await new Promise(resolve => {
      const start = process.hrtime.bigint();
      setTimeout(() => resolve(Number(process.hrtime.bigint() - start) / 1e6), 0);
    });
    return { ok: true, rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576),
      externalMb: Math.round(mem.external / 1048576), eventLoopLagMs: Math.round(lag * 10) / 10,
      uptime: Math.round(process.uptime()), queues,
      limits: { intakeChunk: Number(process.env.INTAKE_CHUNK || 2000),
        workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 1) } };
  });

  app.get('/ready', async () => {
    const ping = await pingDB();
    return { ready: ping.ok, schema: API_SCHEMA, storage: ping.driver };
  });
  /** Proves the configured database is reachable right now (used by `npm run db:check`). */
  app.get('/health/db', async () => {
    const ping = await pingDB();
    const info = dbInfo();
    return { ...ping, ...info, at: new Date().toISOString() };
  });
}
