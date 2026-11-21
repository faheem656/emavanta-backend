import { collection } from '../../../../packages/database/store.js';
import { newId, stableHash } from '../../../../packages/shared/utils.js';

/**
 * Append-only, hash-linked audit entry.
 *
 * Ordering uses an explicit `seq` counter instead of timestamps: two events in the
 * same millisecond used to make the "previous hash" ambiguous, which showed up as a
 * falsely broken chain in Security.
 */
// Serialise writes per organisation so two concurrent actions cannot claim the same seq.
const chains = new Map();
const enqueue = (org, task) => {
  const prev = chains.get(org) || Promise.resolve();
  const next = prev.then(task, task);
  chains.set(org, next.catch(() => {}));
  return next;
};

export const audit = async (ctx, action, resource, details = {}) => {
  if (!ctx?.organizationId) return;
  return enqueue(ctx.organizationId, () => writeEntry(ctx, action, resource, details));
};

const writeEntry = async (ctx, action, resource, details) => {
  const last = await collection('audit_logs').findOne({ organizationId: ctx.organizationId }, { sort: { seq: -1 } });
  const seq = (last?.seq || 0) + 1;
  const entry = {
    _id: newId(), organizationId: ctx.organizationId, actorId: ctx.user?.id, action, resource, details, seq,
    hash: stableHash(last?.hash || 'genesis', action, resource, JSON.stringify(details)),
    createdAt: new Date().toISOString()
  };
  await collection('audit_logs').create(entry);
  return entry;
};

/** Recompute the chain in seq order. Returns the first broken entry (or null). */
export const verifyChain = logs => {
  const ordered = [...logs].sort((a, b) => (a.seq || 0) - (b.seq || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
  let prev = null, broken = null;
  for (const entry of ordered) {
    const expected = stableHash(prev?.hash || 'genesis', entry.action, entry.resource, JSON.stringify(entry.details || {}));
    if (expected !== entry.hash) { broken = entry; break; }
    prev = entry;
  }
  return { ordered, broken };
};

/** Re-link every entry in order (used only for a chain that predates `seq`). */
export const rechain = async organizationId => {
  const logs = await collection('audit_logs').find({ organizationId });
  const ordered = [...logs].sort((a, b) => (a.seq || 0) - (b.seq || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
  let prev = null, repaired = 0;
  for (const [i, entry] of ordered.entries()) {
    const hash = stableHash(prev?.hash || 'genesis', entry.action, entry.resource, JSON.stringify(entry.details || {}));
    if (entry.hash !== hash || entry.seq !== i + 1) {
      await collection('audit_logs').updateOne({ _id: entry._id }, { $set: { hash, seq: i + 1 } });
      repaired++;
    }
    prev = { hash };
  }
  return { repaired, entries: ordered.length };
};
