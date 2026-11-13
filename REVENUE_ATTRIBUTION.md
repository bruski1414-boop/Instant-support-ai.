# Veyra revenue evidence ledger

## What it records

The revenue ledger accepts only:
- `booking_confirmed`: a booking the hotel has confirmed in its own records.
- `addon_paid`: an add-on the hotel confirms has been paid.

Each record requires an external booking/payment reference, a hotel evidence-source reference, an amount, currency and confirmation timestamp. Amounts are stored as integer minor currency units to avoid floating-point money errors.

## Attribution labels

- `veyra_linked_hotel_attested`: an owner/admin selected a conversation belonging to the same hotel workspace. This is hotel-attested attribution, not independent proof that Veyra caused the booking.
- `hotel_reported_unlinked`: the hotel supplied a confirmed revenue record but did not link it to a Veyra conversation. It is deliberately excluded from the Veyra-linked total.

The dashboard shows these totals separately for the trailing 30 days and does not combine different currencies.

## Controls

- Revenue entry is limited to workspace owners and administrators.
- Revenue reads and writes are restricted to workspace owners and administrators.
- All reads and writes are scoped to the authenticated organization ID.
- Conversation links must resolve to a conversation in the same workspace, and a database foreign key clears the link if that conversation is deleted.
- Revenue writes require the existing session CSRF token.
- A database uniqueness constraint on organization, event type and external reference prevents duplicate submissions, including concurrent retries.
- Every accepted record creates an audit-log entry in the same database transaction as the revenue record, so a failed audit write cannot leave an unaudited revenue entry.
- The server validates event type, source/reference lengths and characters, amount precision, currency format, event date and optional conversation UUID.
- When a conversation is supplied, the server verifies it belongs to the same hotel workspace before accepting the event.

## Current limitations

This is a manual hotel-attestation workflow. It is not yet connected to a property-management system, booking engine, payment processor or accounting platform. Veyra cannot independently verify that a booking completed, that an add-on was paid, or that the hotel source reference is genuine. A manager must check the hotel's source system before entering the record.

The dashboard's Veyra-linked label means only that the hotel linked the record to a Veyra conversation. Revenue views are hidden from staff/viewer roles; only workspace owners and administrators can view or enter financial records. It must not be marketed as independently verified incremental revenue or proof of causation. A future PMS/payment integration should use authenticated provider events, stable external IDs, refund/reversal handling and reconciliation before stronger claims are made.

## API

- `GET /api/admin/revenue`: returns 30-day totals by currency and the latest 50 hotel-attested records.
- `POST /api/admin/revenue`: owner/admin only. Accepts `type`, `externalReference`, `sourceReference`, `amount`, `currency`, `occurredAt` and optional `conversationId`.

All POST requests use the existing authenticated session and CSRF protection.
