# Email and payments setup

Do not accept payments before independent security, operational, tax/legal and PCI review and successful end-to-end testing in your own environment. This implementation is experimental and both payment methods are disabled by default. No actual provider credentials are included. Never share passwords, OTPs, secret keys, RPC URLs containing credentials, wallet private keys or seed phrases.

## Signup email (Nodemailer SMTP)

Set values in the backend `.env` and restart the API. For Hostinger Email, verify its hPanel mailbox settings first. Typical configuration:

```dotenv
SMTP_PROVIDER=hostinger
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_REQUIRE_TLS=true
SMTP_USER=your-mailbox@your-domain.com
SMTP_PASSWORD=your-mailbox-password
SMTP_FROM=your-mailbox@your-domain.com
```

The password is the mailbox password, not the hosting account password. Alternatively use port 587, `SMTP_SECURE=false` and `SMTP_REQUIRE_TLS=true`. Do not weaken certificate verification. Run from the backend host:

```sh
npm run smtp:check -- your-inbox@example.com
```

An SMTP connection error cannot be resolved in source code if the hostname, firewall, DNS, provider credentials or outbound port is wrong. The check reports allow-listed error code/cause/phase and configuration-source information; acceptance does not guarantee inbox delivery. If asking for assistance, share only the sanitized code and whether the diagnostic succeeds—never credentials, full provider responses or OTPs. Signup OTPs are hashed in the database and delivered through Nodemailer.

## Card via Stripe

Requires a connected MongoDB replica set/Atlas, a strong JWT secret and matching Stripe secret/publishable keys and webhook signing secret in backend `.env`. Configure an HTTPS Stripe webhook endpoint at `https://YOUR_BACKEND_HOST/api/v1/webhooks/stripe`, subscribed to `payment_intent.succeeded`. Retain the endpoint signing secret separately from API keys. Then, only after security review and staged tests, explicitly opt in:

```dotenv
STRIPE_PAYMENTS_ENABLED=true
STRIPE_SECRET_KEY=sk_live_your_secret_key
STRIPE_PUBLISHABLE_KEY=pk_live_your_publishable_key
STRIPE_WEBHOOK_SECRET=whsec_your_signing_secret
```

Do not put secrets in the Next.js environment. Test keys are accepted only in isolated non-production with `STRIPE_ALLOW_TEST_KEYS=true` (or automated tests); use a separate database/workspace because test payments can activate plans in that environment. They are rejected in production. Configure webhook endpoints and keys in the same Stripe mode and account. `npm run payments:check` reports prerequisites, not whether the keys belong to the same account or whether a charge works.

Card input is hosted in Stripe's CardElement and sent directly to Stripe. Amounts and order binding come from the server. After the bank/3DS confirmation, the API retrieves the PaymentIntent and verifies its amount, currency, metadata and mode; activation and invoice are atomic MongoDB writes. Signed webhooks plus periodic reconciliation help recover if the customer closes the page; keep workers running and monitor failure. The client can resume or cancel a pending intent. Concurrent/conflicting orders may require manual review; do not ask the customer to pay again until reconciled. The integration charges **once per plan term**, not an automatically renewing subscription. Refunds, chargebacks and disputes are not automatically reconciled with entitlements; monitor Stripe and handle these manually. Saved cards are not supported in this integration.

## USDT on BNB Smart Chain

Requires MongoDB transactions, a verified owner with MFA, configured SMTP, a trusted BSC mainnet RPC and a valid public receiving address. After review and staged testing, configure `CRYPTO_PAYMENTS_ENABLED=true`, `BSC_RPC_URL`, `BSC_USDT_RECEIVING_ADDRESS` and `PLATFORM_OWNER_EMAIL`. `npm run payments:check` and the MFA-gated owner dashboard show which prerequisite needs attention; the checks do not prove SMTP delivery. `npm run bsc:check` checks the network/contract and `npm run smtp:check` checks mail transport separately.

Customers connect and sign their own wallet, then send exact USDT for a plan or eligible add-on. A crypto add-on grants the purchased quantity for one month from owner approval; it does not renew automatically. Active crypto add-ons are tracked separately from legacy/manual add-ons and expire by background sweep or the next authenticated request. Owner sees the transaction in Administration and approves after automated chain/recipient/amount/confirmation verification. The expected review time is 5–15 minutes but is not guaranteed. Refund terms are subject to applicable law. Approval creates a term with no automatic renewal. An open payment locks other checkout methods to avoid duplicate charges. A prepared but abandoned or expired USDT order can remain locked until an operator investigates; never manually clear it without verifying whether funds were sent. Owner alerts are best-effort; inspect the dashboard and retry failed emails.

Wallet connect is available separately and never sends a payment. Confirm payment remains disabled until all prerequisites pass, the wallet is on BNB Smart Chain, and terms are accepted. The wallet and network are checked again before the transfer. An interrupted wallet request can still require manual reconciliation; do not pay twice.


### Canceling and reconciliation

For new checkout orders, an order can be canceled only before the server records that a wallet transfer was requested. That server transition and cancellation are mutually exclusive. If a wallet prompt was interrupted, if a transfer was requested, or if an older order lacks that tracking, the customer must not pay again until an operator investigates. The owner may manually close an unsubmitted lock only after checking the wallet and chain and explicitly recording a reason. This does not prove that a pending or later transaction cannot arrive; never use it as a shortcut to clear uncertain payments. Rejecting a submitted payment does not refund or reverse the transfer and does not automatically release the lock. On-chain funds require separate reconciliation.

### Legacy demo identities and cancellation requests

Legacy seeded users are never created in live MongoDB. After backing up the database, run `npm run demo:cleanup` in the backend to inspect exact legacy seed IDs. It is a dry run. Only after reviewing its output, run `npm run demo:cleanup -- --apply` to remove eligible records in a transaction. The cleanup skips the configured owner, modified users, users with sessions or API keys, users with outside memberships/workspaces, and the demo owner if other people are in that workspace. Skipped records are not deleted; inspect them manually. The script does not delete the demo workspace or its data.

A customer can immediately cancel a v2 USDT order only before a wallet transfer is requested. For older orders or orders where transfer was requested/submitted, cancellation is a request: the lock stays in place and the owner is notified on the dashboard (email is best effort). Investigate wallet and chain history; lack of a hash does not prove that no transfer was sent. For unsubmitted orders the owner can attest their investigation and close the lock; delayed transfers may still arrive. For submitted payments, an owner can reject review and, only after manually reconciling funds and legal refund obligations outside the app, explicitly close the rejected-payment lock. Neither action issues a refund or reverses an on-chain transfer. Payment approval is blocked while a cancellation request is open. Do not request another payment before resolving the original.
