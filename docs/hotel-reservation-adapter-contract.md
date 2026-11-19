# Hotel room availability and reservation adapter

Status: **provider-neutral orchestration contract; not a live PMS integration**.

## Flow

1. Validate guest dates, occupancy, room type, full name, international phone number and explicit consent to share the contact details.
2. Ask the hotel's tenant-scoped provider adapter for availability for the exact room type, dates and occupancy.
3. Require a fresh inventory result (maximum five minutes old), matching property/workspace, room type and exact stay dates.
4. Only if at least one room is available, call the provider's reservation-write operation with a stable idempotency key.
5. Tell the guest the reservation is confirmed only if the provider returns a confirmed status and a non-empty booking reference. Pending, ambiguous, stale or failed responses go to hotel staff.

## Provider adapter interface

The hotel IT-approved adapter must expose:

- \`organizationId\`: the hotel workspace it is authorised to access;
- \`supportsIdempotency: true\`: provider-side deduplication for retries;
- \`checkAvailability({ organizationId, arrivalDate, departureDate, roomTypeCode, adults, children })\`: returns exact matching inventory, \`roomsAvailable\`, \`observedAt\`, and \`validUntil\`;
- \`createReservation({ organizationId, idempotencyKey, guest, arrivalDate, departureDate, adults, children, roomTypeCode })\`: performs the provider write and returns its authoritative status and booking reference.

The adapter must be implemented against the actual PMS API, not by guessing endpoints or fields. It must also securely manage provider credentials, enforce tenant isolation, map room categories, and document rate plans, taxes, cancellation terms, payment/deposit requirements, modifications and cancellation semantics.

## Safety and privacy rules

- Never claim availability from stale, incomplete, mismatched or unavailable inventory.
- Recheck inventory immediately before a write.
- Never call a reservation confirmed until the provider confirms it with a reference.
- Provider retries must be idempotent; do not blindly repeat an uncertain write.
- Collect and transmit guest contact details only after explicit consent and hotel approval of the privacy notice, retention policy and secure data flow.
- Never accept card details or payment credentials in chat.
- Do not log guest contact details or provider payloads.
- Route uncertain outcomes to hotel staff.

## Activation blockers

Shebara's PMS, actual room-category mapping, approved rate plans, and authorised vendor sandbox access have not yet been confirmed. The current Mews connector in the other development branch is demo-only and read-only. This contract does not turn it into a production writer and must not be connected to real guest data until hotel IT authorises and tests the provider adapter.

## Remaining release blockers before any reservation write

The current provider-neutral service is a draft orchestration contract, not a production-ready booking flow. Before it can safely create a real reservation, the adapter and workflow must also:

- Obtain a live, property-approved quote for the exact dates, occupancy, room category and rate plan.
- Show the complete payable total, currency, included taxes/fees, deposit schedule and cancellation terms to the guest.
- Require explicit acceptance of that exact quote and verify it has not expired or changed immediately before writing.
- Reconcile timeouts and connection-loss outcomes by looking up the original idempotency key before any retry; an uncertain write must never be blindly repeated.
- Apply the property's privacy notice, data-retention policy and access controls, and use a hotel-approved secure credential vault.

These quote and reconciliation gates are not yet implemented in the shared booking service. Until they are, do not enable guest-facing reservation writes. Use sandbox-only synthetic guest data during development.
