# Emavanta backend — Node.js

This directory is a standalone Node.js 22+ Fastify application. The backend root `server.js` is the actual startup file (`npm start` or `node server.js`). It has its own `package.json`, lockfile, `.env.example`, API, workers, database/queue modules and diagnostics. It does not need the frontend source directory. The frontend is a separately hosted Next.js application.

## Windows / local setup

Extract **this backend folder** into its own location. For a local run, change the example APP_URL to http://localhost:3000; for deployment, use the real frontend HTTPS origin. Preserve your existing secrets and data when upgrading. If upgrading from the earlier combined project, copy the previous `.env` to this folder; otherwise copy `.env.example` to `.env`. Never upload or share `.env`.

```powershell
npm ci
npm run db:check
npm run dev
```

Open a second terminal and start the separate frontend. The default API port is 4000. Stop with Ctrl+C; after changing `.env`, stop and restart the backend. Use `npm start` on a Node.js host (set that host's `NODE_ENV=production` and `PORT` environment variables). Port values supplied by the host take precedence over `.env`. Configure `APP_URL` as the public HTTPS frontend origin, for example `https://app.example.com`, so emailed links and tracking go through the frontend proxy.

## MongoDB URI format

In `.env`, there must be exactly **one** key and **one** scheme on one line:

```dotenv
MONGODB_URI=mongodb+srv://YOUR_DATABASE_USER:YOUR_ENCODED_PASSWORD@YOUR_CLUSTER.mongodb.net/emavanta?retryWrites=true&w=majority
```

Replace the example values with the connection details from Atlas. Do **not** paste `MONGODB_URI=` a second time inside the value. If the user or password has reserved characters, URL-encode those components only (`@` → `%40`, `#` → `%23`, `%` → `%25`); do not encode the entire URI. Allow the server's IP in Atlas Network Access, and use the Atlas **database user** (not your Atlas account login). `npm run db:check` diagnoses connectivity without printing the connection string. Process environment variables override `.env.local`, which overrides `.env`. Run diagnostics on the actual backend server. Never send a URI, credentials or OTP to support.

MongoDB Atlas or a replica set is required for transaction-dependent features including crypto. Production requires persistent MongoDB and refuses a missing or failed database; memory storage is local-only and nondurable. Back up and test database restoration.

## Email, owner and crypto

Configure SMTP and `PLATFORM_OWNER_EMAIL` in `.env`; see `docs/HOSTINGER-EMAIL-SETUP.md`. Verify that owner's email, enable MFA and sign in again with MFA to access global administration. Run the commands **separately**:

```powershell
npm run smtp:check -- you@example.com
npm run bsc:check
npm run payments:check
npm test
```

The SMTP test sends an optional message; acceptance does not guarantee inbox delivery. Signup OTP codes are stored as hashes, not plaintext. Do not expose passwords, tokens or codes.

Stripe card and USDT payment flows are experimental and **disabled by default**; OAuth sender login remains disabled. Independent security, legal and live-service testing is required before accepting funds. For required configuration, signed webhook setup and limitations see `docs/PAYMENT-AND-EMAIL-SETUP.md`.

## Workers and deployment

By default the API process starts workers and scheduler automatically. For separate scaling set `RUN_EMBEDDED_WORKERS=false` on API-only hosts and run `npm run workers` on dedicated worker hosts using the same persistent MongoDB and Upstash settings. `npm run workers` may also add workers to the default embedded setup; never run a separate worker with memory storage. MongoDB-based leases, retry and sweep provide at-least-once delivery, not exactly-once; a crash can duplicate external email. Monitor queue growth/failures and reconcile after incidents. Some multi-step campaign launch/intake operations are not transactional. Secure the API with HTTPS and network controls, use strong unique secrets, configure trusted proxy infrastructure and test backup/restore. The included tests do not certify production safety.

## Contact requests and email

Set `PLATFORM_OWNER_EMAIL` and SMTP settings. Contact requests are saved in MongoDB and atomically queued for notification; the screen says queued, not delivered. Workers send the contact fields to the configured owner with visitor email as Reply-To. The MFA-protected owner dashboard lists messages and can retry failed notifications. SMTP acceptance does not guarantee inbox delivery; delivery is at-least-once and an ambiguous SMTP outcome may duplicate a notification. Test with `npm run smtp:check -- you@example.com` and an actual contact submission. Messages contain personal data; configure access controls and an appropriate retention policy. The contact limit uses `RATE_LIMIT_BACKEND`: set `TRUSTED_PROXY_IPS` only to controlled reverse proxies after validating the real forwarding path; otherwise all visitors behind a proxy can appear as one IP.

## Current limitations

Read `docs/OPERATIONS-REVIEW.md` before deployment: not all plan limits or calendar-based sending counters are fully enforced, campaign reservation and queueing are not one atomic operation, and email delivery is at-least-once. The build is not certified production-ready.

### Separate-domain checklist

Set `APP_URL` to the public **frontend** HTTPS origin and deploy this backend to its own HTTPS domain. The frontend host sets its own `API_ORIGIN` to the backend HTTPS origin before building. Additional exact browser origins can be configured with `CORS_ALLOWED_ORIGINS`; public embedded forms permit cross-origin requests without credentials. CORS is not access control. See `SEPARATE-DOMAIN-DEPLOYMENT.md` included in the download for the complete checklist.
