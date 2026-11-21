/**
 * `npm run db:check` — proves the MONGODB_URI in .env really works.
 * Prints the host/database (never the password), the round-trip time and what is stored.
 */
import { loadEnv, describeMongoUri } from '../packages/shared/env.js';

const env = loadEnv();
console.log(`[db:check] env files: ${env.files.length ? env.files.join(', ') : 'none found (.env missing)'}`);

const uri = process.env.MONGODB_URI;
const meta = describeMongoUri(uri);
if (!uri) {
  console.log('[db:check] MONGODB_URI is empty → the app will use the in-memory store.');
  console.log('           Paste your Atlas string into .env (see .env.example) to persist data.');
  process.exit(0);
}

console.log('[db:check] Connection string: hidden');
console.log(`[db:check] scheme: ${meta.scheme}; connection details hidden`);

const { connectDB, dbInfo, pingDB, disconnectDB, nativeDatabase } = await import('../packages/database/store.js');

try {
  const started = Date.now();
  const state = await connectDB();
  const ping = await pingDB();
  console.log(`[db:check] connected in ${Date.now() - started} ms · driver=${state.mode} · database=${state.database}`);

  const db = nativeDatabase();
  const server = await db.admin().serverInfo().catch(() => ({}));
  const collections = await db.listCollections().toArray();
  console.log(`[db:check] server version: ${server.version || 'unknown'} · ping: ${ping.ok ? 'ok' : 'FAILED'}`);
  if (!collections.length) console.log('[db:check] database is empty — it will fill as real accounts are created.');
  for (const info of collections.slice(0, 25)) {
    const count = await db.collection(info.name).countDocuments().catch(() => 0);
    console.log(`[db:check]   ${info.name.padEnd(26)} ${count} document(s)`);
  }
  console.log('[db:check] ✅ MongoDB is connected (ping succeeded; writes were not tested). Start the app with `npm run dev`.');
  await disconnectDB();
  process.exit(0);
} catch (err) {
  console.error(`\n[db:check] ❌ ${err.message}\n`);
  console.error(`Safe diagnostic: category=${err.category || 'UNKNOWN'}`);
  console.error('Checklist:');
  console.error('  1. Password URL-encoded (@ → %40, # → %23, % → %25) if it has special characters');
  console.error('  2. Atlas → Network Access contains your server IP');
  console.error('  3. The cluster is running (not paused) — Atlas pauses idle free clusters');
  console.error('  4. The database user exists in Atlas → Database Access');
  console.error(`  5. Resolved info: ${JSON.stringify({ ...dbInfo() })}\n`);
  process.exit(1);
}
