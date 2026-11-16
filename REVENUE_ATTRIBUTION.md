# Veyra revenue evidence ledger

## What it records

The revenue ledger accepts only:
- `booking_confirmed`: a booking the hotel has confirmed in its own records.
- `addon_paid`: an add-on the hotel confirms has been paid.

Each record requires an external booking/payment reference, a hotel evidence-source reference, an amount, currency and confirmation timestamp. Amounts are stored as integer minor currency units to avoid floating-point money errors.

## Attribution labels

- `veyra_linked_hotel_attested`: an owner/admin selected a conversation belonging to the same hotel workspace. This is hotel-attested attribution, not independent proof that Veyra caused the booking.
- `hotel_reported_unlinked`: the hotel supplied a confirmed revenue record but did not link it to a Veyra conversation. It is deliberately excluded from the Veyra-linked total.

The dashboard shows these totals separately for a rolling 30 × 24-hour window and does not combine different currencies. The API returns the exact UTC `windowStart` (inclusive) and `windowEnd` (exclusive) used for both totals. Totals are net of all recorded refunds and chargebacks attached to events in that window, as of the report time; an adjustment recorded later can therefore reduce the current net total for an event in an earlier window. The event and adjustment tables show the latest 50 records and are history views, not window-limited lists.

A separate `linkedConversationCount` counts distinct Veyra conversation IDs attached by hotel staff to eligible revenue events in the same reporting window. It is not an “influenced conversations” metric and does not establish that Veyra caused or incrementally generated revenue. Veyra does not yet calculate influenced conversations or staff time saved. Those measures require separately agreed hotel definitions and measured baseline data; no time-saving estimate is displayed until that evidence exists.

## Controls

- Revenue entry is limited to workspace owners and administrators.
- Revenue reads and writes are restricted to workspace owners and administrators.
- All reads and writes are scoped to the authenticated organization ID.
- Conversation links must resolve to a conversation in the same workspace, and a database foreign key clears the link if that conversation is deleted.
- Revenue writes require the existing session CSRF token.
- A database uniqueness constraint on organization, event type and external reference prevents duplicate submissions, including concurrent retries.
- Every accepted record creates an audit-log entry in the same database transaction as the revenue record, so a failed audit write cannot leave an unaudited revenue entry.
- Owners/admins can record partial refunds and chargebacks against an original booking or paid add-on. Each adjustment has its own unique external reference, hotel evidence source and audit record.
- Adjustments must match the original event currency and cannot exceed the remaining unadjusted amount. The original gross event is retained; dashboard totals subtract recorded adjustments to show net revenue.
- The server validates event type, source/reference lengths and characters, amount precision, currency format, event date and optional conversation UUID.
- When a conversation is supplied, the server verifies it belongs to the same hotel workspace before accepting the event.

## Provider webhook foundation

Workspace owners and administrators can create or rotate a workspace-specific webhook credential through the authenticated, CSRF-protected endpoint:

- `POST /api/admin/integrations/revenue-webhook/rotate`
- Owners/admins can inspect connection status through `+"`GET /api/admin/integrations/revenue-webhook`"+` without exposing the secret.
- The setup dashboard shows the receiver URL and lets an owner/admin generate or rotate the one-time secret. The response returns a one-time secret and a tenant-specific receiver path: `POST /api/integrations/:slug/revenue`
- Send the secret in the `X-Veyra-Webhook-Token` header over HTTPS. Never put it in a URL, browser code, source control or logs.
- Veyra stores only a SHA-256 hash of the secret. Rotating the secret immediately invalidates the previous one.
- Owners/admins can disable the webhook through `+"`DELETE /api/admin/integrations/revenue-webhook`"+`. Disabling revokes the active credential immediately and records an audit event.
- Secret rotation and its audit record are committed in one database transaction. The receiver is rate-limited and accepts only `booking_confirmed` and `addon_paid` events in the same normalized shape used by the manual ledger: `type`, `externalReference`, `sourceReference`, `amount`, `currency` and `occurredAt`.
- The external reference is unique per hotel and event type. Repeated deliveries return HTTP 409 rather than adding revenue again.
- Accepted webhook events are always recorded as `hotel_reported_unlinked`. A provider-supplied conversation ID is deliberately ignored: a booking system event alone does not prove that Veyra caused the booking.
- Every accepted event updates the connection's last-received time and writes an audit record in the same database transaction.

This is a generic authenticated receiver, not a finished connector to a named PMS, booking engine or payment processor. A provider or secure integration relay must be configured to map its verified events into Veyra's normalized payload and send the custom header. Provider-specific authentication, event mapping, retries, automated cancellation/refund delivery, reconciliation and production credentials remain future work. Refunds and chargebacks must currently be entered by an owner/admin through the dashboard.

## Provider-correlation foundation (not yet live)

The repository now defines a provider-neutral, synthetic-only foundation for linking a confirmed reservation to the Veyra conversation that generated an opaque booking reference:

- Veyra can issue a random 256-bit token and retain only its SHA-256 hash with the hotel workspace, conversation, issue time and expiry.
- A canonical provider reservation event may carry that token only when the provider has a documented, hotel-authorised metadata/reference field that can preserve it.
- The matcher accepts only a confirmed reservation event, an exact token match, the same hotel workspace, an event timestamp inside the token's attribution window, and an unconsumed token.
- The match output contains the provider name, opaque provider event/reservation references and the Veyra conversation ID; it does not copy guest names, emails, phone numbers, card data or free-text notes.
- A reservation total is booked value, not proof that cash was collected. It is returned separately as booking value only when the source supplies a valid amount and currency. It must not be relabelled as a paid add-on.

This is a pure data-contract/matching foundation plus synthetic fixtures and tests. It is **not** wired to a database table, guest-chat token issuance route, revenue-ledger write, or Mews mapping. No production booking can currently be automatically linked by this feature. The existing `veyra_linked_hotel_attested` label still means a hotel owner/admin manually linked a record; it is not provider-verified attribution. The persistence layer must later consume each token transactionally and enforce provider-event idempotency before this matcher is used for live reporting.

## Transactional persistence foundation (not yet live)

The provider-correlation contract now has a PostgreSQL persistence service in `booking-attribution-store.js`:

- Intent issuance verifies that the conversation belongs to the supplied hotel workspace, stores only the SHA-256 token hash, and writes an audit record in the same transaction. The raw 256-bit token is returned once to the caller and is never stored.
- Confirmed reservation matching locks the tenant-scoped intent, checks the token and attribution window, writes one match, consumes the intent and records an audit entry in one transaction.
- Database uniqueness constraints prevent one intent, provider event ID or provider reservation ID from creating multiple matches for the same hotel. Concurrent retries return a duplicate result.
- Conversation deletion clears the conversation link but preserves the minimal provider evidence; a detached intent cannot be matched again.
- Optional reservation totals are stored separately as booking value. They are not inserted into `revenue_events`, are not treated as paid cash, and are not eligible for the paid-add-on metric.

This persistence service is exercised by the dedicated PostgreSQL tenant-isolation CI suite using synthetic provider events. It is not yet called by guest chat or a provider webhook route. No named PMS adapter currently maps a documented provider metadata field into the Veyra token, and no provider signature/authentication is configured for this path. Therefore it does not yet create live provider-verified conversions or dashboard revenue.

## Current limitations

This is a manual hotel-attestation workflow. It is not yet connected to a property-management system, booking engine, payment processor or accounting platform. Veyra cannot independently verify that a booking completed, that an add-on was paid, or that the hotel source reference is genuine. A manager must check the hotel's source system before entering the record.

The dashboard's Veyra-linked label means only that the hotel linked the record to a Veyra conversation. Revenue views are hidden from staff/viewer roles; only workspace owners and administrators can view or enter financial records. It must not be marketed as independently verified incremental revenue or proof of causation. A future PMS/payment integration should use authenticated provider events, stable external IDs, refund/reversal handling and reconciliation before stronger claims are made.

## API

- `GET /api/admin/revenue`: returns 30-day totals by currency and the latest 50 hotel-attested records.
- `POST /api/admin/revenue`: owner/admin only. Accepts `type`, `externalReference`, `sourceReference`, `amount`, `currency`, `occurredAt` and optional `conversationId`.
- `POST /api/admin/revenue/adjustments`: owner/admin only. Accepts `type` (`refund` or `chargeback`), `originalType`, `originalExternalReference`, `externalReference`, `sourceReference`, `amount`, `currency` and `occurredAt`.

All POST requests use the existing authenticated session and CSRF protection.
