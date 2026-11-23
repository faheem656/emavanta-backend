# Workflow automation engine

## Supported behavior

An automation is saved as a draft or paused. Activation is a separate, explicit owner action and starts real messages for **future** qualifying events only; contacts already on a list are not backfilled. A given contact can enroll in a given automation once. Repeated list/tag/form/API events and manual enrollment requests for the same contact/workflow do not create another enrollment.

Supported triggers:

- `contact_added`: a new contact is created with the selected list, or an existing contact is newly added to a list.
- `tag_added`: a new contact is created with a matching tag, or a matching tag is newly added to an existing contact.
- `form_submitted`: a valid hosted-form submission. A linked automation is also supported.
- `manual`: select up to 500 contacts from the dashboard, or use the manual enrollment endpoint.
- `api`: call `POST /api/v1/sequences/{id}/trigger` with a workspace contact ID.

Steps support email sends, waits, and the supported tracked-behavior conditions shown in the editor. Email steps require an active sender and a valid template. Conditions require an earlier email and at least 30 minutes of accumulated wait before the condition. Each message uses the workflow's default sender unless its step overrides it. Suppressed or unsubscribed addresses are skipped.

## Legacy workflow safety

At backend startup, after MongoDB connects and before workers start, `prepareAutomationEngine()` pauses active workflows that do not have the new `executionEnabled` marker and marks them for review. It cancels pending/claimed legacy `sequence.step` rows from `scheduled_jobs`, because those jobs have no enrollment/step idempotency ledger. The migration is idempotent. Operators must inspect the trigger, audience consent, template, sender, and limits, then explicitly reactivate a workflow to resume sending. No data migration was run against a production database as part of this package's tests.

## Queue, retries, and operator review

MongoDB stores durable trigger events, enrollment snapshots, step runs, and queue jobs. The scheduler sweep republishes pending triggers and requeues eligible enrollment steps after worker restarts. Mongo queue processing is at-least-once, not exactly-once. A deterministic enrollment and step-run key prevents duplicate workflow records; provider calls cannot be made transactionally with MongoDB. If a send's provider outcome is ambiguous or a worker lease expires during a send, the step moves to `needs_review` instead of automatically resending. Check the sender provider before choosing **Provider accepted** or **Provider did not accept**; retry only after confirming no delivery.

## Release verification

From the repository root, use Node.js 22 or newer:

```sh
npm ci
npm test
node --test --test-concurrency=1 tests/integration/*.test.js
npm run build
npm run check:routes
npm run audit:ui
```

The automation integration tests use an isolated MongoDB replica set and mock mail transport. They verify trigger persistence and execution, per-contact idempotency, list/tag additions, API/manual enrollment, email sender overrides, actual open/click tracking, delays, conditions, pause/reactivation, suppression, ambiguous-send resolution, legacy migration idempotency, and scheduler recovery. These tests do not verify your live SMTP/OAuth account, production MongoDB cluster, DNS, or inbox placement. Configure a persistent replica set, verify mailboxes, and test with a consented internal address before enabling production workflows.
