# Operations review and current limitations

Do not treat this build as production-ready merely because a diagnostic or test passes. Use staging, independent security review, provider monitoring, backups, and real end-to-end tests before sending email or accepting payments.

## Sessions
The dashboard checks `/auth/me` before rendering and redirects an invalid/revoked session to sign-in. Sign-in/sign-up check an existing session and redirect a valid session to the dashboard. An API outage does not silently clear a valid token. Authorization is enforced by the backend, not the frontend gate. Current bearer tokens are stored in browser localStorage; XSS can expose them. An HttpOnly cookie/CSRF design has not been implemented.

## Contact limits
Contact creation, bulk imports and the CSV worker check the workspace's plan and purchased add-ons. This includes platform-owner workspaces; there is no owner exemption. MongoDB contact creation needs a replica set (or Atlas) because parallel writers use transactions. Soft-deleted contacts are excluded from the count but cannot be silently re-created using the same email. Large queued imports can be partially completed before a later chunk hits a limit; inspect failed jobs and contact counts before retrying.

## Sending and other limits: incomplete
Campaign launches conditionally reserve send allowance to reduce concurrent oversubscription, but launch, reservation and queue submission are not yet one atomic transaction. Other sending paths and plan dimensions are not comprehensively metered or concurrency-safe. Usage-cycle rollover and mailbox day/week counters require additional work; sending can stop unexpectedly or limits can be inaccurate. Contact limits do not imply that all seats, mailboxes, automations, sends or other quotas are enforced. Do not rely on the application as the sole quota enforcement for live sending.

## Redis and queue
The Upstash Redis REST option applies only to shared sending rate buckets, not the job queue. MongoDB jobs use at-least-once leases. A paused outreach account or reached cap now preserves the remaining job for retry, but day/week counter rollover is not complete and an operator may need to investigate a repeatedly deferred job. A crash or an ambiguous SMTP response can duplicate an external send: no exactly-once guarantee exists. Monitor failed/deferred jobs and reconcile before restarting work. See `UPSTASH-SETUP.md`.

## Signup email
`npm run smtp:check -- your-own-inbox@example.com` must be run on the backend host, using the same effective environment as the running API. SMTP success means provider acceptance, not guaranteed inbox delivery. Share only the diagnostic code/cause/phase; never share credentials, full provider replies, verification codes or private keys. Test signup, failure/retry and a real inbox end-to-end after configuring SMTP. Local fake SMTP tests do not validate the live provider.

## Platform owner account controls

The configured verified platform owner must have MFA enabled and sign in with MFA to list accounts and change account status. Suspend and soft-delete revoke sessions and API keys; restore requires a fresh login and new API keys. Soft-delete is reversible and retains user, workspace, financial and audit records: it is not permanent erasure or a data-deletion compliance workflow. Changing an individual account does not automatically pause workspace campaigns or disable other workspace members. The owner cannot change their own account through these controls.

## Crypto terms

Add-ons purchased with USDT are one-time, one-month grants after approval; there is no auto-renewal. Confirmation, owner approval, cancellation and manual reconciliation are experimental. Review `PAYMENT-AND-EMAIL-SETUP.md` before accepting funds. Local mocked-chain tests do not prove real payment settlement.

## MongoDB outage and recovery

`MongoServerSelectionError`, a monitor connection closing, and queue-unavailable messages indicate MongoDB could not currently be selected or reached. They do not identify the exact cause. Workers use bounded retry/backoff and the MongoDB driver monitors for recovery; no in-memory fallback is used for a configured MongoDB URI. Existing durable jobs remain in MongoDB, but a job already executing when the connection failed may have performed an external side effect before its acknowledgement: do not blindly repeat email or payment operations. Queue processing is at-least-once, not exactly-once. API errors return a sanitized 503; sessions are not signed out merely because the database is unavailable.

On the **actual backend host**, run `npm run db:check` from the backend folder. Share only its `Safe diagnostic: category=...` line. Do not share your URI, database password, full logs or IP address. A successful check is a momentary connectivity test, not proof that a later outage cannot occur.

For Atlas, check that the cluster is running, the database user is valid, the backend host's current outbound public IP is allowed under Atlas Network Access, DNS/SRV resolution works, and your firewall/VPN/ISP permits the Atlas hosts and port. A laptop's IP can change; if API and workers run on separate hosts, allow each host's actual egress IP. Do not open network access globally or disable TLS as a shortcut. For self-hosted MongoDB, check the database service, connection limits, DNS, network path and firewall instead. Contact the database or hosting provider if needed. Changing the UI cannot repair an upstream network or database failure.

Default MongoDB server selection timeout is 8 seconds, queue polling is 2 seconds, and worker concurrency is 1 lane per queue. Existing `.env` values override defaults. Tune only after monitoring; many workers and frequent polling can put substantial load on a small MongoDB cluster. If an existing `.env` uses a much larger `MONGODB_TIMEOUT_MS`, browser requests can time out first. Stop old API/worker processes before restarting the updated backend. Do not erase the database or blindly replay interrupted operations.

A browser extension that injects attributes (such as `cz-shortcut-listen` on `<body>`) can cause a development hydration warning. The root body narrowly suppresses this external-attribute warning; unrelated hydration mismatches are not intentionally suppressed. Disable the extension for the site or test in a clean browser profile if warnings persist.
