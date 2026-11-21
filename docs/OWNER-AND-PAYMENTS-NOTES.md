# Owner access and experimental USDT checkout

## Before enabling

Crypto is **disabled by default**. A real public deployment needs a security review, payment/legal/compliance review and end-to-end tests with your own services and operational monitoring. Do not accept funds based on automated tests alone. Stripe card checkout is also opt-in and experimental; OAuth sender identity is disabled. See PAYMENT-AND-EMAIL-SETUP.md. Use secured HTTPS, backups, access controls and a MongoDB replica set or Atlas with transactions; local in-memory storage or a standalone MongoDB server cannot settle payments.

Configure `MONGODB_URI`, long non-placeholder `JWT_SECRET`, `ENCRYPTION_KEY`, SMTP settings, `PLATFORM_OWNER_EMAIL`, `BSC_RPC_URL` and `BSC_USDT_RECEIVING_ADDRESS` in the backend `.env` file. The address is **public**, never a private key or recovery phrase. Set `CRYPTO_PAYMENTS_ENABLED=true` only after your review and testing. Register and email-verify the exact owner account, enable authenticator MFA, then sign out and back in using MFA. The dashboard can show setup state but configuration is not proof of real mail delivery or operational security.

From this backend folder, use separate commands: `npm run db:check`, `npm run smtp:check -- you@example.com`, `npm run bsc:check`. Do not publish logs containing secrets. BSC RPC is a trusted dependency; secure and monitor it. The 64-confirmation threshold is a risk control, not an absolute finality guarantee.

## Customer and owner workflow

Customers choose a paid plan, accept terms and connect a browser wallet on BNB Smart Chain. They sign a wallet ownership message and authorize the exact quoted number of USDT (1 USDT per USD) to the configured address. A transaction hash and signature are submitted to a tenant-bound order. The browser retains submission recovery information locally; if submission fails, retry from that device and never send again. If recovery data is lost, contact the operator with the hash; there is no automatic support recovery interface. Transactions mined outside the order quote window, sent with the wrong token, amount, sender or recipient, or with insufficient confirmation cannot be automatically approved. Transfers are irreversible; support must resolve exceptions manually according to law.

The owner dashboard lists pending submissions and notification state; it checks chain ID, canonical receipt, transaction sender, token contract, exact transfer, address, order window and 64 confirmations before transactional approval. The transaction hash is unique across orders; approval creates an invoice and activates the plan once. If the workspace plan changed during checkout, automatic approval stops for manual review. Same-plan renewal extends an existing crypto expiry; expiry downgrades to Free through the worker sweep or upon subsequent authenticated requests or worker delivery. The sweep can be delayed by outages; no exact timer guarantee. No automatic renewal. Client billing shows payment status and invoices.

Dashboard records persist if email notification fails; use the owner panel to retry. Notifications are best-effort: a crash between submission and sending may leave a pending alert; monitor the dashboard. Review is *expected* in 5–15 minutes, not guaranteed. Terms state no refunds except where applicable law requires otherwise; obtain legal advice. Never promise or imply a transaction has been verified or a plan activated before approval.

## Operational limits

Mongo jobs use renewable leases with retries and recovery, with at-least-once semantics: a crash or lost lease can repeat an external send. Scheduled and outbox sweeps help recovery but campaign launch and intake have non-transactional steps; inspect and reconcile after faults. Completed/failed queue records accumulate and need monitoring. Verify capacity, failover and backup/restore under your workload. The tests use a local Mongo replica set plus mock BSC RPC and fake SMTP, not your production services. OTP codes are stored as hashes with expiry and limited attempts rather than plaintext; delivery depends on real SMTP.
