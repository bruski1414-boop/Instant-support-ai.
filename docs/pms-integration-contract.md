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
