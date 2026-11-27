/**
 * Data layer.
 *
 * Storage driver is decided by `MONGODB_URI` alone (NOT by DEMO_MODE):
 *   MONGODB_URI set   → MongoDB (works with Atlas `mongodb+srv://`, or local `mongodb://`)
 *   MONGODB_URI unset → in-memory store (data resets on restart; fine for a demo)
 *
 * Both drivers expose the exact same async API, so routes never care which is live.
 * `DEMO_MODE` only controls demo sign-in / mock sending / seeding.
 *
 * The Mongo driver is the native one (mongodb v6) on purpose: document ids in this
 * app are strings (uuids), and a Mongoose ObjectId `_id` would fail to cast them.
 */
import { MongoClient } from 'mongodb';
import { newId } from '../shared/utils.js';
import { describeMongoUri, mongoUriConfigurationIssue } from '../shared/env.js';

const memory = new Map();
let client = null;
let db = null;
let connected = false;
let lastError = null;
let dbName = null;

// Do not inspect or emit raw URI/driver messages in public responses or logs.
export function isMongoUnavailable(error) {
 const names=new Set(['MongoServerSelectionError','MongoNetworkError','MongoNetworkTimeoutError','MongoTopologyClosedError','MongoServerClosedError','MongoNotConnectedError','MongoPoolClearedError','MongoOperationTimeoutError','MongoWaitQueueTimeoutError']);
 const codes=new Set(['MONGODB_UNAVAILABLE','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EHOSTUNREACH','ENETUNREACH']);
 const seen=new Set();let e=error;
 while(e&&typeof e==='object'&&!seen.has(e)){seen.add(e);if(names.has(e.name)||codes.has(e.code))return true;e=e.cause;}
 return false;
}
export function mongoFailureCategory(error) {
 const msg=String(error?.message||'');
 if(/MONGODB_URI_FORMAT|unescaped|URI malformed|percent/i.test(msg))return 'CONFIG';
 if(error?.code===18||/bad auth|authentication failed/i.test(msg))return 'AUTH';
 if(/ENOTFOUND|querySrv|getaddrinfo|EAI_AGAIN/i.test(msg))return 'DNS';
 if(/TLS|SSL|certificate/i.test(msg))return 'TLS';
 if(isMongoUnavailable(error)||/timed out|ECONNREFUSED|ECONNRESET|closed|Could not connect/i.test(msg))return 'NETWORK_OR_SERVER';
 return 'UNKNOWN';
}
function setMongoAvailable(usable){
 if(!db || isMemoryMode())return;
 if(usable!==connected){connected=usable;lastError=usable?null:'MongoDB is temporarily unavailable.';console.warn(usable?'[db] Connection restored.':'[db] Connection unavailable; driver will reconnect automatically.');}
}
export function noteMongoFailure(error){if(isMongoUnavailable(error))setMongoAvailable(false);}
export function noteMongoSuccess(){setMongoAvailable(true);}
function trackTopology(owner, event){
 if(client!==owner||!db)return;
 const desc=event.newDescription;
 const usable=desc?.type==='ReplicaSetWithPrimary'||desc?.type==='Sharded'||desc?.type==='LoadBalanced'||(desc?.type==='Single'&&[...desc.servers.values()].some(s=>['Standalone','RSPrimary','Mongos','LoadBalancer'].includes(s.type)));
 setMongoAvailable(usable);
}

const s = v => (typeof v === 'string' ? v : v?._id ?? v?.id ?? v);

export const storageMode = () => (process.env.MONGODB_URI ? 'mongo' : 'memory');
export const isMemoryMode = () => storageMode() === 'memory';

export const dbInfo = () => {
  const meta = describeMongoUri(process.env.MONGODB_URI);
  return {
    driver: storageMode(),
    connected: storageMode() === 'memory' ? true : connected,
    database: storageMode() === 'memory' ? 'in-memory' : dbName,
    host: meta.host || null,
    srv: !!meta.srv,
    configured: meta.configured,
    error: lastError,
    collections: storageMode() === 'mongo' && db ? null : memory.size
  };
};

/** Diagnostics are categorized without ever logging driver strings or credentials. */
const explainMongoFailure = (err, uri) => {
  const msg = String(err?.message || err);
  const issue = mongoUriConfigurationIssue(uri);
  let reason = 'The server could not be reached or the connection settings are invalid.';
  let fix = 'Check the URI, network access list, DNS, database user and server availability.';
  if (issue) { reason = 'The MongoDB URI contains duplicated configuration text.'; fix = issue; }
  else if (/unescaped|percent|URI malformed/i.test(msg)) {
    reason = 'The URI contains invalid or unescaped characters.';
    fix = 'URL-encode special characters in the database username and password; paste the URI only once.';
  } else if (/bad auth|authentication failed|auth/i.test(msg)) {
    reason = 'MongoDB rejected authentication.';
    fix = 'Check the Atlas database username and password; URL-encode special characters.';
  } else if (/ENOTFOUND|querySrv|getaddrinfo|EAI_AGAIN/i.test(msg)) {
    reason = 'MongoDB DNS lookup failed.';
    fix = 'Check the Atlas hostname and DNS/SRV access.';
  } else if (/ETIMEDOUT|ECONNREFUSED|timed out|Could not connect to any servers/i.test(msg)) {
    reason = 'MongoDB connection timed out or was refused.';
    fix = 'Check Atlas Network Access for your server IP, network rules, and whether the cluster is running.';
  }
  return `Could not connect to MongoDB.\n  Connection string: hidden\n  Reason: ${reason}\n  Fix: ${fix}`;
};

const normalizeUri = raw => {
  let uri = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!uri) return uri;
  // People often paste just the host, or forget the scheme.
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    uri = uri.includes('mongodb.net') || uri.includes('.mongodb.net') ? `mongodb+srv://${uri}` : `mongodb://${uri}`;
  }
  return uri;
};

export const connectDB = async () => {
  const rawUri = process.env.MONGODB_URI;
  const uri = normalizeUri(rawUri);
  if (!uri && process.env.NODE_ENV === 'production') throw new Error('MONGODB_URI is required in production; in-memory storage is not durable.');
  if (!uri) {
    console.log('[db] no MONGODB_URI — using the in-memory store (data resets on restart).');
    return { mode: 'memory' };
  }
  if (connected) return { mode: 'mongo', database: dbName };

  const meta = describeMongoUri(uri);
  dbName = process.env.MONGODB_DB || meta.database || 'emavanta';
  const allowFallback = process.env.MONGODB_ALLOW_MEMORY_FALLBACK === 'true';

  try {
    const issue = mongoUriConfigurationIssue(rawUri);
    if (issue) throw new Error('MONGODB_URI_FORMAT');
    client = new MongoClient(uri, {
      appName: process.env.MONGODB_APP_NAME || 'Emavanta',
      maxPoolSize: Number(process.env.MONGODB_MAX_POOL || 20),
      serverSelectionTimeoutMS: Number(process.env.MONGODB_TIMEOUT_MS || 8000),
      connectTimeoutMS: 12000,
      socketTimeoutMS: 60000,
      retryWrites: true,
      retryReads: true,
      ...(process.env.MONGODB_TLS === 'true' ? { tls: true } : {})
    });
    const owner=client;
    client.on('topologyDescriptionChanged',event=>trackTopology(owner,event));
    await client.connect();
    db = client.db(dbName);
    await db.command({ ping: 1 });
    connected = true;
    lastError = null;
    console.log(`[db] connected to MongoDB ${meta.srv ? '(Atlas SRV)' : ''} · db=${dbName} · host=${meta.host} · collections=${(await db.listCollections().toArray()).length}`);
    return { mode: 'mongo', database: dbName, host: meta.host };
  } catch (err) {
    connected = false;
    lastError = 'MongoDB connection failed; see server diagnostics.';
    try { await client?.close(); } catch { /* ignore */ }
    client = null;
    const explained = explainMongoFailure(err, rawUri);
    console.error(`[db] ${explained}`);
    if (allowFallback && process.env.NODE_ENV !== 'production') {
      console.error('[db] Memory fallback is disabled for a configured MongoDB URI; startup must fail rather than lose queued work.');
    }
    const error = new Error(explained);
    error.code = 'MONGODB_UNAVAILABLE';
    error.category = mongoFailureCategory(err);
    throw error;
  }
};

export const pingDB = async () => {
  if (isMemoryMode()) return { ok: true, driver: 'memory' };
  try { if(!db)throw new Error('Not connected'); await db.command({ ping: 1 }); connected = true; lastError=null; return { ok: true, driver: 'mongo', database: dbName }; }
  catch { connected = false; lastError = 'MongoDB ping failed.'; return { ok: false, driver: 'mongo', error: lastError }; }
};

// Internal services only: no raw database handles leave server-side code.
export const nativeDatabase = () => {
  if (!db || isMemoryMode()) { const e=new Error('A MongoDB database is required'); e.code='MONGODB_UNAVAILABLE'; throw e; }
  return db;
};
export const mongoClient = () => {
  if (!client || isMemoryMode()) { const e=new Error('A MongoDB client is required'); e.code='MONGODB_UNAVAILABLE'; throw e; }
  return client;
};

export const disconnectDB = async () => {
  try { await client?.close(); } catch { /* ignore */ }
  client = null; db = null; connected = false; ensured.clear();
};

/* ------------------------------------------------------------------ */
/* in-memory driver                                                    */
/* ------------------------------------------------------------------ */

/**
 * Mongo semantics for array fields: `{ listIds: {$in: [id]} }` and `{ listIds: id }`
 * both mean "the array contains id". The in-memory driver has to match that or a
 * launch would find no contacts in demo mode.
 */
const contains = (value, needle) =>
  Array.isArray(value) ? value.some(v => s(v) === s(needle)) : s(value) === s(needle);

const OPERATORS = new Set(['$in', '$nin', '$ne', '$gt', '$gte', '$lt', '$lte', '$exists']);

/**
 * Operator objects must be evaluated as a group and then *return*, otherwise the
 * equality fallback compares the value to `{"$gt": ...}` and every ranged query
 * silently matches nothing. That bug made cursor pagination return 0 rows.
 */
const matchesField = (value, cond) => {
  if (cond instanceof RegExp) return cond.test(String(value ?? ''));
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return contains(value, cond);
  const keys = Object.keys(cond);
  const isOperator = keys.some(k => OPERATORS.has(k));
  if (!isOperator) return JSON.stringify(value) === JSON.stringify(cond);
  const asArray = Array.isArray(value) ? value : [value];
  if ('$in' in cond && !cond.$in.some(x => contains(value, x))) return false;
  if ('$nin' in cond && cond.$nin.some(x => contains(value, x))) return false;
  if ('$ne' in cond && asArray.some(v => contains(v, cond.$ne))) return false;
  if ('$gt' in cond && !asArray.some(v => v > cond.$gt)) return false;
  if ('$gte' in cond && !asArray.some(v => v >= cond.$gte)) return false;
  if ('$lt' in cond && !asArray.some(v => v < cond.$lt)) return false;
  if ('$lte' in cond && !asArray.some(v => v <= cond.$lte)) return false;
  if ('$exists' in cond && (value !== undefined) !== cond.$exists) return false;
  return true;
};

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([k, v]) => k === '$or' ? v.some(f => matches(doc, f)) : matchesField(k.split('.').reduce((o, p) => o?.[p], doc), v));

const setPath = (doc, key, value) => {
  if (!key.includes('.')) { doc[key] = value; return; }
  const parts = key.split('.');
  let cur = doc;
  for (const part of parts.slice(0, -1)) cur = cur[part] ||= {};
  cur[parts.at(-1)] = value;
};
const getPath = (doc, key) => key.split('.').reduce((o, p) => o?.[p], doc);

const applyUpdate = (doc, update = {}) => {
  if (update.$set) for (const [k, v] of Object.entries(update.$set)) setPath(doc, k, v);
  else if (!update.$inc && !update.$push && !update.$addToSet && !update.$pull)
    for (const [k, v] of Object.entries(update)) setPath(doc, k, v);
  if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) setPath(doc, k, (Number(getPath(doc, k)) || 0) + Number(v));
  if (update.$push) for (const [k, v] of Object.entries(update.$push)) {
    let target = getPath(doc, k);
    if (!Array.isArray(target)) { target = []; setPath(doc, k, target); }
    target.push(v);
  }
  if (update.$addToSet) for (const [k, v] of Object.entries(update.$addToSet)) {
    let target = getPath(doc, k);
    if (!Array.isArray(target)) { target = []; setPath(doc, k, target); }
    if (!target.some(x => JSON.stringify(x) === JSON.stringify(v))) target.push(v);
  }
  if (update.$pull) for (const [k, v] of Object.entries(update.$pull)) { const target=getPath(doc,k); if (Array.isArray(target)) setPath(doc,k,target.filter(x=>!contains(x,v))); }
  if (update.$unset) for (const k of Object.keys(update.$unset)) delete doc[k];
  return doc;
};

const sortRows = (rows, sort) => {
  if (!sort) return rows;
  const [key, dir] = Object.entries(sort)[0];
  return [...rows].sort((a, b) => {
    const av = getPath(a, key), bv = getPath(b, key);
    if (av === bv) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    return (av > bv ? 1 : -1) * (dir === -1 ? -1 : 1);
  });
};

function memoryCollection(name) {
  if (!memory.has(name)) memory.set(name, []);
  const docs = memory.get(name);
  return {
    async find(filter = {}, options = {}) {
      let out = docs.filter(d => matches(d, filter));
      out = sortRows(out, options.sort);
      return out.slice(options.skip || 0, (options.skip || 0) + (options.limit || out.length)).map(d => ({ ...d }));
    },
    async findOne(filter = {}, options = {}) {
      const out = sortRows(docs.filter(d => matches(d, filter)), options.sort);
      return out.length ? { ...out[0] } : null;
    },
    async findById(id) { return this.findOne({ _id: id }); },
    async create(doc) {
      const now = new Date().toISOString();
      const saved = { _id: doc._id || newId(), createdAt: doc.createdAt || now, updatedAt: now, ...doc };
      const i = docs.findIndex(d => String(d._id) === String(saved._id));
      if (i > -1) docs[i] = saved; else docs.push(saved);
      return { ...saved };
    },
    async insertIfAbsent(doc) {
      const id = doc._id || newId();
      const existing = docs.find(d => String(d._id) === String(id));
      if (existing) return { inserted: false, document: { ...existing } };
      const now = new Date().toISOString();
      const saved = { _id: id, createdAt: doc.createdAt || now, updatedAt: now, ...doc };
      docs.push(saved);
      return { inserted: true, document: { ...saved } };
    },
    async insertMany(arr) { const out = []; for (const d of arr) out.push(await this.create(d)); return out; },
    /** Bulk upsert used by campaign intake: one call per chunk instead of one per row. */
    async bulkCreate(arr) { const out = []; for (const d of arr) out.push(await this.create(d)); return out; },
    async updateOne(filter, update) {
      const d = docs.find(x => matches(x, filter));
      if (!d) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(d, update); d.updatedAt = new Date().toISOString();
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      const found = docs.filter(x => matches(x, filter));
      for (const d of found) { applyUpdate(d, update); d.updatedAt = new Date().toISOString(); }
      return { matchedCount: found.length, modifiedCount: found.length };
    },
    async deleteOne(filter) {
      const i = docs.findIndex(x => matches(x, filter));
      if (i < 0) return { deletedCount: 0 };
      docs.splice(i, 1); return { deletedCount: 1 };
    },
    async deleteMany(filter) {
      const keep = docs.filter(x => !matches(x, filter));
      const n = docs.length - keep.length;
      // Mutate in place: adapters may already hold a reference to this array.
      docs.length = 0;
      docs.push(...keep);
      return { deletedCount: n };
    },
    async countDocuments(filter = {}) { return docs.filter(d => matches(d, filter)).length; },
    async aggregate() { return []; }
  };
}

/* ------------------------------------------------------------------ */
/* MongoDB driver                                                      */
/* ------------------------------------------------------------------ */

const ensured = new Set();

/**
 * The indexes that keep list pages and progress counters fast at millions of rows.
 * Anything not listed falls back to the tenant index.
 */
const INDEXES = {
  organizations: [[{ planChangeSource: 1, planExpiresAt: 1 }]],
  contacts: [[{ organizationId: 1, listIds: 1 }], [{ organizationId: 1, email: 1 }]],
  campaign_recipients: [[{ organizationId: 1, campaignId: 1, status: 1 }], [{ campaignId: 1, contactId: 1 }], [{ organizationId: 1, campaignId: 1, status: 1, sendingStartedAt: 1 }]],
  campaign_batches: [[{ campaignId: 1, status: 1, index: 1 }]],
  campaign_chunks: [[{ organizationId: 1, campaignId: 1, offset: 1 }]],
  delivery_events: [[{ organizationId: 1, campaignId: 1, type: 1 }], [{ dedupeKey: 1 }], [{ organizationId: 1, campaignId: 1, type: 1, createdAt: 1 }], [{ organizationId: 1, campaignId: 1, sendingAccountId: 1, type: 1 }]],
  outbox_events: [[{ status: 1, createdAt: 1 }]],
  automation_trigger_events: [[{ organizationId: 1, status: 1, createdAt: 1 }], [{ organizationId: 1, sequenceId: 1, status: 1 }]],
  sequence_enrollments: [[{ organizationId: 1, sequenceId: 1, status: 1 }], [{ organizationId: 1, contactId: 1, sequenceId: 1 }]],
  sequence_step_runs: [[{ organizationId: 1, enrollmentId: 1, stepIndex: 1 }]],
  sessions: [[{ organizationId: 1, status: 1 }], [{ 'token.jti': 1 }]],
  sending_accounts: [[{ organizationId: 1, status: 1 }], [{ status: 1, 'tracking.status': 1, 'tracking.method': 1 }]],
  usage_counters: [[{ organizationId: 1, cycle: 1 }]]
};

const ensureIndex = name => {
  if (ensured.has(name) || !db) return;
  ensured.add(name);
  const specs = INDEXES[name] || [];
  const col=db.collection(name), tasks=specs.length?specs.map(spec=>col.createIndex(spec[0])):[col.createIndex({ organizationId: 1 })];
  Promise.all(tasks).catch(() => { ensured.delete(name); });
};

// Mongo rejects a document without atomic operators ("Update document requires
// atomic operators"); the rest of the codebase sometimes passes a plain object.
const normalizeUpdate = update => {
  const keys = Object.keys(update || {});
  const hasOperator = keys.some(k => k.startsWith('$'));
  const set = { updatedAt: new Date().toISOString() };
  if (!hasOperator) return { $set: { ...update, ...set } };
  if (update.$set) return { ...update, $set: { ...update.$set, ...set } };
  return { ...update, $set: set };
};

function mongoCollection(name) {
  ensureIndex(name);
  const col = () => nativeDatabase().collection(name);
  return {
    async find(filter = {}, options = {}) {
      let cursor = col().find(filter, { projection: options.projection });
      if (options.sort) cursor = cursor.sort(options.sort);
      if (options.skip) cursor = cursor.skip(options.skip);
      if (options.limit) cursor = cursor.limit(options.limit);
      return cursor.toArray();
    },
    async findOne(filter = {}, options = {}) {
      return col().findOne(filter, options.sort ? { sort: options.sort } : {});
    },
    async findById(id) { return this.findOne({ _id: id }); },
    async create(doc) {
      const now = new Date().toISOString();
      const row = { ...doc, _id: doc._id || newId(), createdAt: doc.createdAt || now, updatedAt: now };
      await col().replaceOne({ _id: row._id }, row, { upsert: true });
      return row;
    },
    async insertIfAbsent(doc) {
      const now = new Date().toISOString();
      const row = { ...doc, _id: doc._id || newId(), createdAt: doc.createdAt || now, updatedAt: now };
      try {
        await col().insertOne(row);
        return { inserted: true, document: row };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const existing = await col().findOne({ _id: row._id });
        if (!existing) throw error;
        return { inserted: false, document: existing };
      }
    },
    async insertMany(arr) { const out = []; for (const d of arr) out.push(await this.create(d)); return out; },

    /** Unordered bulk upsert: 2 000 documents in one round trip instead of 2 000. */
    async bulkCreate(arr) {
      if (!arr?.length) return [];
      const now = new Date().toISOString();
      const rows = arr.map(doc => ({ ...doc, _id: doc._id || newId(), createdAt: doc.createdAt || now, updatedAt: now }));
      const batchSize = 1000;
      for (let i = 0; i < rows.length; i += batchSize) {
        const slice = rows.slice(i, i + batchSize);
        await col().bulkWrite(slice.map(row => ({ replaceOne: { filter: { _id: row._id }, replacement: row, upsert: true } })), { ordered: false });
      }
      return rows;
    },
    async updateOne(filter, update) {
      const r = await col().updateOne(filter, normalizeUpdate(update));
      return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
    },
    async updateMany(filter, update) {
      const r = await col().updateMany(filter, normalizeUpdate(update));
      return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
    },
    async deleteOne(filter) { const r = await col().deleteOne(filter); return { deletedCount: r.deletedCount }; },
    async deleteMany(filter) { const r = await col().deleteMany(filter); return { deletedCount: r.deletedCount }; },
    async countDocuments(filter = {}) { return col().countDocuments(filter); },
    async aggregate(pipeline = []) { return col().aggregate(pipeline).toArray(); }
  };
}

/* ------------------------------------------------------------------ */

export const collection = name => (isMemoryMode() ? memoryCollection(name) : mongoCollection(name));

/** Every tenant query MUST go through here: orgId is injected, never trusted from the client. */
export const scoped = (name, ctx) => {
  const org = ctx.organizationId;
  if (!org) throw new Error('Tenant context missing');
  return {
    find: (filter = {}, opts = {}) => collection(name).find({ ...filter, organizationId: org }, opts),
    findOne: (filter = {}, options = {}) => collection(name).findOne({ ...filter, organizationId: org }, options),
    countDocuments: (filter = {}) => collection(name).countDocuments({ ...filter, organizationId: org }),
    create: doc => collection(name).create({ ...doc, organizationId: org }),
    insertMany: docs => collection(name).insertMany(docs.map(d => ({ ...d, organizationId: org }))),
    bulkCreate: docs => collection(name).bulkCreate(docs.map(d => ({ ...d, organizationId: org }))),
    updateOne: (filter, update) => collection(name).updateOne({ ...filter, organizationId: org }, update),
    updateMany: (filter, update) => collection(name).updateMany({ ...filter, organizationId: org }, update),
    deleteOne: filter => collection(name).deleteOne({ ...filter, organizationId: org }),
    deleteMany: filter => collection(name).deleteMany({ ...filter, organizationId: org }),
    aggregate: pipeline => collection(name).aggregate([{ $match: { organizationId: org } }, ...pipeline])
  };
};

export const seedIfEmpty = async (name, docs) => {
  const col = collection(name);
  if (await col.countDocuments() === 0) await col.insertMany(docs);
};

// Multi-document financial transitions require MongoDB transactions (replica set
// or Atlas). Never degrade to non-transactional or in-memory operations.
export async function withMongoTransaction(operation) {
  const client = mongoClient();
  const database = nativeDatabase();
  const session = client.startSession();
  try { return await session.withTransaction(() => operation(database, session), { readConcern:{level:'snapshot'}, writeConcern:{w:'majority'} }); }
  finally { await session.endSession(); }
}
