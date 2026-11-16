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

The current implementation now includes a PostgreSQL persistence service and synthetic tenant-isolation tests. It stores token hashes only, validates the conversation's hotel workspace, locks and consumes an intent in the same transaction as the match and audit record, and enforces unique provider event/reservation IDs. Conversation deletion detaches the link so a deleted transcript cannot remain attributed. However, the service is not yet wired to guest chat or an authenticated provider event route, does not write to the revenue ledger, and has no provider-specific metadata mapping. The read-only Mews demo client does not currently supply this token. No live provider-correlated conversion metric is available yet.

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

## Mews Connector API discovery (checked 2026-11-16)

Official documentation reviewed before selecting any Mews correlation field:

- The current [Reservations operation](https://docs.mews.com/connector-api/operations/reservations) documents the 2023-06-06 Reservation object, including its state and origin fields, but does not document a reservation-level `ExternalIdentifier` or dedicated custom metadata field. Do not repurpose `OriginDetails`, `ChannelNumber` or other operational fields as a Veyra token.
- Mews exposes [Service order notes](https://docs.mews.com/connector-api/operations/serviceordernotes) that can be added to and retrieved from a reservation or product order. These are ordinary notes, not a documented private integration-metadata field. A note-based token is only a candidate if the hotel explicitly approves its operational visibility and retention and the behaviour is verified in a sandbox; it is not enabled by this contract.
- [General Webhooks](https://docs.mews.com/connector-api/events/wh-general) identify the enterprise/integration and affected entity; the integration must retrieve entity details through the relevant API operation and must deduplicate webhook deliveries.
- For Veyra-created add-on orders, [Add order](https://docs.mews.com/connector-api/operations/orders) supports `LinkedReservationId`; product-order and order-item parameters expose `ExternalIdentifier`. [Get all order items](https://docs.mews.com/connector-api/operations/orderitems) returns item amounts, bill references, accounting state and external identifiers. This is a plausible documented correlation path for add-ons created by Veyra, subject to hotel-authorised write scopes and sandbox validation.
- `AccountingState=Closed` is not by itself proof of payment: Mews defines it as an item closed on a bill or invoice. [Bills](https://docs.mews.com/connector-api/operations/bills) distinguish a `Receipt` (paid in full) from an `Invoice` (not paid in full), while [Payments](https://docs.mews.com/connector-api/operations/payments) expose states such as `Charged`, `Pending`, `Canceled` and `Failed`. Paid add-on reporting must reconcile item, bill, payment, refunds/rebates and currency rather than treating a closed item as cash received.
- Mews' [accounting integration guidance](https://docs.mews.com/connector-api/use-cases/accounting) notes that accounting items are posted to guest profiles; only stay products are inherently related back to a reservation by `OrderId`. Other service products must not be assumed to carry a reservation link unless Veyra explicitly creates the order with `LinkedReservationId`.

**Current blocker:** the public reservation contract does not establish a dedicated field for Veyra's booking-enquiry token. No Mews credential, sandbox property or hotel approval is available in this work. Do not implement a live reservation correlation mapping until the hotel approves a documented note-based alternative or Mews confirms a supported reservation metadata field. The add-on order path can be prototyped separately with synthetic data, but must remain read-only until write scopes and reconciliation semantics are approved.

