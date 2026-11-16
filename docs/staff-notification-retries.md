# Staff notification retry operations

## Current behaviour

Guest handoffs attempt a staff webhook immediately. Delivery status and attempt counts are stored on the escalation. Failed or abandoned sends can be retried by the bounded worker in `scripts/staff-notification-retry.js`.

The worker is **not scheduled by this repository's current Render Blueprint**. Adding the npm script does not create a recurring job. Until an authorised operator configures a scheduler, recovery requires a trusted operator to run the job manually.

## Before enabling retries

1. Confirm the hotel owner has approved the staff-notification workflow and the endpoint is controlled by that hotel.
2. Verify the hotel's webhook from its Veyra setup dashboard.
3. Configure `DATABASE_URL`, `DATABASE_SSL`, `STAFF_WEBHOOK_ENCRYPTION_KEY`, and `STAFF_WEBHOOK_ALLOWED_HOSTS` in the trusted runtime. Never put secrets in source control, command-line arguments, logs, or support tickets.
4. Ensure the allowed-host list contains only the exact approved webhook hostnames. The worker fails closed if encryption or the host allowlist is missing.
5. Confirm the database is backed up and that the operator has an approved recovery procedure.

## Running manually

From a trusted deployment environment with the repository dependencies installed:

```sh
npm run staff-notifications:retry
```

The job scans a bounded batch (up to 50) of unresolved escalations for verified hotel webhooks. It uses an atomic database lease to avoid overlapping sends, rechecks tenant ownership, rejects redirects, signs each event with HMAC-SHA256, and uses the escalation ID as the idempotency key. The job prints aggregate counts only; do not add guest message content or webhook secrets to logs.

## Retry limits and recovery

- Automatic worker attempts are capped at five per escalation.
- Failed sends are eligible after a five-minute cooldown.
- A `sending` lease older than two minutes can be reclaimed after a crashed worker.
- Resolved escalations are excluded.
- A hotel notification that remains undelivered must be handled through the hotel's manual staff-contact process. Do not silently mark it delivered.

A future scheduler must run this command in a trusted environment with the same secrets and network restrictions, at a cadence approved by the hotel operator. Do not add a recurring production job until the database backup/restore process, webhook ownership, and alerting for repeated failures have been verified.

## Pilot limitation

Automated retry code and tests do not prove that a real hotel webhook is reachable or that hotel staff receive and act on notifications. Verify delivery with a hotel-controlled test endpoint and an authorised pilot before enabling guest-facing handoffs.