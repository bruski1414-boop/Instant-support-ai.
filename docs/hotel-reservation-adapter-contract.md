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

Public evidence indicates that Red Sea Global selected Oracle OPERA Cloud Central for Shebara and other named resorts in its May 2024 announcement. A Shebara Resort IT Officer listing also names OPERA PMS. This makes Oracle OPERA the best-supported integration target, but does not establish the exact deployed OPERA modules/version, the property's OHIP tenant configuration, enabled API scopes, room/rate identifiers, or permission for Veyra to connect. Those details must be confirmed by Shebara/Red Sea Global hotel IT in writing. The current Mews connector in the other development branch is demo-only and read-only; it is not evidence that Shebara uses Mews. No Oracle OPERA adapter is implemented or connected. Do not connect to real guest data until hotel IT authorises and tests the provider adapter.

## Remaining release blockers before any reservation write

The current provider-neutral service is a draft orchestration contract, not a production-ready booking flow. Before it can safely create a real reservation, the adapter and workflow must also:

- Obtain a live, property-approved quote for the exact dates, occupancy, room category and rate plan.
- Show the complete payable total, currency, included taxes/fees, deposit schedule and cancellation terms to the guest.
- Require explicit acceptance of that exact quote and verify it has not expired or changed immediately before writing.
- Reconcile timeouts and connection-loss outcomes by looking up the original idempotency key before any retry; an uncertain write must never be blindly repeated.
- Apply the property's privacy notice, data-retention policy and access controls, and use a hotel-approved secure credential vault.

These quote and reconciliation gates are not yet implemented in the shared booking service. Until they are, do not enable guest-facing reservation writes. Use sandbox-only synthetic guest data during development.

## Implemented quote-consent workflow (provider-neutral)

`quote-consent-workflow.js` now provides a provider-neutral two-stage workflow:

1. `issue()` requests a quote for one tenant, exact dates, room type, rate plan and occupancy.
2. It validates the returned quote's currency, integer minor-unit amounts, tax/fee/deposit bounds, cancellation text, scope and expiry.
3. It returns the exact terms and a short-lived HMAC-signed token. The signing secret is server-side only.
4. `confirm()` requires explicit acceptance, verifies the signed token, validates the guest contact fields, and requests the quote again immediately before writing.
5. If any quoted term changes, it refuses the write and requires a fresh quote and fresh guest acceptance.
6. If a reservation write throws, it looks up the original idempotency key once. It never blindly repeats the write. Unresolved outcomes are handed to staff.

The provider adapter must implement `getQuote`, `createReservation`, and `lookupReservationByIdempotencyKey`. This module is not connected to a real PMS, payment provider, credential vault or hotel account. Its tests use synthetic data only. Do not enable guest-facing booking or transmit real guest details until the hotel has approved the provider, scopes, privacy notice, retention controls, credential storage, sandbox test plan and operational sign-off.


## Explicit booking activation readiness gate

The application now reports booking readiness separately from general pilot readiness at `/api/health` and `/api/readiness`. A general support pilot must not be mistaken for a reservation-enabled pilot.

`readyForBookings` remains false unless all of these server-side evidence flags are explicitly set to the string `true`:

- `PMS_ADAPTER_CONFIGURED`
- `PMS_AVAILABILITY_SANDBOX_TEST_PASSED`
- `PMS_BOOKING_SANDBOX_TEST_PASSED`
- `QUOTE_WORKFLOW_INTEGRATED`
- `HOTEL_BOOKING_APPROVED`
- `HOTEL_BOOKING_PRIVACY_APPROVED`
- `PMS_CREDENTIAL_VAULT_CONFIGURED`

The endpoint exposes each result under `bookingChecks`. Missing values, truthy strings other than `"true"`, and numeric values do not pass. These flags are release evidence gates, not automatic proof that a vendor connection works; they must only be set after the corresponding technical test and hotel approval have actually occurred. Do not set them to make the dashboard appear ready. The quote workflow is not wired into a live PMS booking route. Oracle OPERA is the publicly indicated target, but the exact Shebara configuration and authorised integration access remain unverified.
