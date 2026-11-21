# Upstash Redis REST setup

This integration uses the Upstash Redis **REST API** for shared sending and public-contact token buckets. BullMQ is **not installed**; the queue is not Redis-backed. It does not replace MongoDB: accounts, payments, transaction outbox, and background job queue remain in MongoDB. Migrating a live job queue requires a separate plan; do not delete existing MongoDB queue records. Never store the REST token in frontend settings or share it.

1. Create an Upstash Redis database and copy its REST URL and REST token from the Upstash console.
2. Set these in the **backend** environment of every API and worker instance, using the same Redis database:

```dotenv
RATE_LIMIT_BACKEND=upstash
UPSTASH_REDIS_REST_URL=https://your-database.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-rest-token
```

3. Restart all backend instances. Run `npm run redis:check` from the backend host for a PING plus a short-lived multi-key Lua write/read/delete check. A clustered Redis configuration requiring keys in the same hash slot may reject the existing multi-key buckets; test this before use. Do not rename or reset bucket keys in a live deployment because that can permit a burst. Do not post the URL or token.
4. During a coordinated maintenance window, stop senders before switching rate limit backends. Redis starts with new, full buckets; schedule the switch so provider quotas have recovered. Do not run Mongo and Upstash limiter modes concurrently against the same senders.

Multi-bucket rate reservations execute atomically in one Redis Lua script and use Redis server time. Failed reservations do not consume other buckets. A Redis error fails closed; no automatic memory/Mongo fallback. Workers defer affected jobs without exhausting job attempts and retry after a bounded delay; misconfiguration therefore requires operator attention. A timeout may mean a reservation was applied, so it is not automatically retried or refunded; capacity refills naturally (zero-refill buckets may need operator attention). Refunding is best effort and a timeout may leave capacity reserved. Campaign sends do not refund a reservation after an ambiguous delivery error. Redis eviction, flush, database replacement or failover data loss can reset buckets and permit a burst. Use non-evicting settings, monitoring, appropriate limits and capacity, and avoid using Redis as the sole hard provider quota. Upstash usage and charges depend on the selected plan.

For payment setup use `npm run payments:check`; a Redis connection does not prove Stripe or blockchain payments work. Confirm real-payment flows only after independent review and end-to-end testing; never share private keys or wallet seed phrases.
