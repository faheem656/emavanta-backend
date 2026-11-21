const buckets = new Map();
/** Atomic-enough in-memory token bucket. Local in-process bucket; distributed delivery limits use MongoDB. */
export const memoryBucket = ({ capacity, refillPerSec }) => {
  const state = { tokens: capacity, last: Date.now() };
  return {
    take(n = 1) {
      const now = Date.now();
      state.tokens = Math.min(capacity, state.tokens + ((now - state.last) / 1000) * refillPerSec);
      state.last = now;
      if (state.tokens < n) return { ok: false, retryAfter: Math.ceil((n - state.tokens) / refillPerSec) };
      state.tokens -= n;
      return { ok: true, remaining: Math.floor(state.tokens) };
    }
  };
};
export const getBucket = (key, opts) => {
  if (!buckets.has(key)) buckets.set(key, memoryBucket(opts));
  return buckets.get(key);
};
