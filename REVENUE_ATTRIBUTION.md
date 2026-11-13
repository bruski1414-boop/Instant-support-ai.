# Veyra revenue evidence ledger

## What it records

The revenue ledger accepts only:
- `booking_confirmed`: a booking the hotel has confirmed in its own records.
- `addon_paid`: an add-on the hotel confirms has been paid.

Each record requires an external booking/payment reference, a hotel evidence-source reference, an amount, currency and confirmation timestamp. Amounts are stored as integer minor currency units to avoid floating-point money errors.

## Attribution labels

- `veyra_linked_hotel_attested`: an owner/admin selected a conversation belonging to the same hotel workspace. This is hotel-attested attribution, not independent proof that Veyra caused the booking.
- `hotel_reported_unlinked`: the hotel supplied a confirmed revenue record but did not link it to a Veyra conversation. It is deliberately excluded from the Veyra-linked total.

The dashboard shows these totals separately for the trailing 30 days and does not combine different currencies. Totals are net of recorded refunds and chargebacks.

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

## Current limitations

This is a manual hotel-attestation workflow. It is not yet connected to a property-management system, booking engine, payment processor or accounting platform. Veyra cannot independently verify that a booking completed, that an add-on was paid, or that the hotel source reference is genuine. A manager must check the hotel's source system before entering the record.

The dashboard's Veyra-linked label means only that the hotel linked the record to a Veyra conversation. Revenue views are hidden from staff/viewer roles; only workspace owners and administrators can view or enter financial records. It must not be marketed as independently verified incremental revenue or proof of causation. A future PMS/payment integration should use authenticated provider events, stable external IDs, refund/reversal handling and reconciliation before stronger claims are made.

## API

- `GET /api/admin/revenue`: returns 30-day totals by currency and the latest 50 hotel-attested records.
- `POST /api/admin/revenue`: owner/admin only. Accepts `type`, `externalReference`, `sourceReference`, `amount`, `currency`, `occurredAt` and optional `conversationId`.
- `POST /api/admin/revenue/adjustments`: owner/admin only. Accepts `type` (`refund` or `chargeback`), `originalType`, `originalExternalReference`, `externalReference`, `sourceReference`, `amount`, `currency` and `occurredAt`.

All POST requests use the existing authenticated session and CSRF protection.
