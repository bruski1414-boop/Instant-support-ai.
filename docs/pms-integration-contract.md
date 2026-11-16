# PMS integration contract (v1)

This is the provider-neutral contract for future PMS adapters. It is not a live connection to any PMS.

## Adapter boundary

Each provider adapter must implement two explicit mappings:
- provider reservation webhook/API payload -> canonical reservation event
- provider availability response -> canonical availability snapshot

Use `createPmsAdapter({ provider, mapReservationEvent, mapAvailabilitySnapshot })` from `pms-integration.js`. The adapter rejects unsupported statuses, malformed dates, invalid money and stale inventory snapshots.

## Canonical reservation event

Required fields:
- `eventId`: provider event identifier, suitable for idempotency
- `eventType`: `reservation.created`, `reservation.updated`, `reservation.cancelled`, `reservation.checked_in`, or `reservation.checked_out`
- `occurredAt`: ISO-8601 UTC timestamp
- `reservationId`: provider reservation reference
- `status`: `pending`, `confirmed`, `cancelled`, `checked_in`, `checked_out`, or `no_show`
- `arrivalDate` / `departureDate`: hotel-local calendar dates (YYYY-MM-DD)

Optional fields are room type code and total amount in integer minor currency units with ISO currency. Guest names, emails, phone numbers, card details and free-text notes are intentionally excluded from this contract.

## Booking enquiry correlation (foundation only)

The canonical reservation event may include an optional `attributionToken`. It must be a Veyra-issued, random 256-bit base64url token (43 characters), not a guest identifier or free-text note.

`booking-attribution.js` defines the first-stage contract:

1. Issue a token for one Veyra conversation and hotel workspace with a maximum 30-day validity window.
2. Return the raw token only to the caller that must pass it to the booking flow; store only its SHA-256 hash alongside the tenant ID, conversation ID, issue time and expiry.
3. A provider adapter may map the token only from a documented provider metadata/reference field that the hotel has explicitly authorised. Do not guess at provider fields or scrape it from guest PII.
4. Match only `reservation.created` or `reservation.updated` events whose status is exactly `confirmed`, whose tenant matches, whose token hash matches in constant time, whose event timestamp is within the issue/expiry window, and whose intent has not already been consumed.
5. Persist token consumption, the provider name, provider event ID, reservation ID and conversation link in one database transaction. Enforce uniqueness on the tenant/provider/event ID so retries and replays cannot create duplicate conversions.
6. If a valid source amount and currency are present, expose them as **booking value**, not cash collected. Missing amounts stay missing; a confirmed reservation must never be converted into an invented revenue amount.

The current implementation is deliberately limited to the pure model and synthetic fixture. It does not yet issue tokens from guest chat, persist/consume them, write to the revenue ledger, or map any live provider. The read-only Mews demo client does not currently supply this token. No provider-correlated conversion metric is available yet.

## Availability snapshot

Requires property and room-type references, stay dates, non-negative room count, source event ID, observed timestamp and validity expiry. A snapshot may be treated as fresh for at most 15 minutes. Expired or malformed inventory must never be used to tell a guest that a room is available.

## Security and launch requirements

Before connecting a real provider:
1. Select the PMS and confirm its official API/webhook documentation, scopes, sandbox and commercial access.
2. Verify webhook signatures and timestamps using the provider's documented scheme; do not rely on a shared token alone where the provider supports signatures.
3. Enforce per-hotel credentials, tenant isolation, event idempotency, replay protection and audit logs.
4. Store only the minimum reservation data needed; do not import guest PII or payment-card data into Veyra by default.
5. Reconcile webhook events against provider API state and handle out-of-order delivery.
6. Never claim a booking is confirmed or inventory is live until the provider response is verified.
7. Run sandbox and two-hotel isolation tests before any supervised pilot.

No PMS credentials, guest data, or live provider calls are used by this foundation.
