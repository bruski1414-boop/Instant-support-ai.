# Booking attribution matching (v1)

## What is implemented

- `booking-attribution.js` issues a cryptographically random 256-bit, one-time correlation token, stores only its SHA-256 hash in the intent record, and matches only a confirmed reservation-create/update event inside the intent's validity window.
- `booking-attribution-store.js` persists intents and matches in tenant-scoped PostgreSQL transactions. It verifies that the originating conversation belongs to the same organization, locks an intent while consuming it, writes an audit record, and relies on database uniqueness constraints to prevent reuse of an intent, provider event, or provider reservation.
- A replay of the already-consumed same provider event/reservation is returned as `duplicate`; a second conversation attempting to claim the same provider reservation is also rejected as duplicate.
- Only minimal booking metadata is retained. Guest names, emails, phone numbers, payment details and free-text notes are discarded by the canonical reservation-event normalizer.
- Booking value is optional and retained only when it is a positive integer minor-unit amount with a supported currency. A confirmed reservation can be matched without claiming a booking amount.

## What the tests establish

`tests/booking-attribution.test.js` tests the pure token and matching contract. `tests/booking-attribution-store.test.js` tests store orchestration with a deliberately small in-memory PostgreSQL-client double: same-tenant intent creation, hash-only persistence, confirmed matching, replay idempotency, tenant mismatch, unconfirmed events, duplicate reservation claims, and rollback on persistence failure.

The in-memory client double does not replace the PostgreSQL tenant-isolation integration suite and does not prove database locking or unique-index behaviour under real concurrent transactions. Those guarantees depend on the actual schema constraints and must also be exercised against PostgreSQL before production use.

## Not yet production-connected

This is not yet a live hotel booking-attribution integration. The store is not currently wired to a guest-facing booking-intent issuance flow or an authenticated, signature-verified PMS webhook route. There is no verified provider-specific mapping for the reservation event fields, and no live PMS sandbox test is claimed. Do not issue or accept real booking events through this contract until those boundaries are implemented and reviewed.

A future integration must:
1. Issue the one-time token only through a trusted Veyra conversation flow, without exposing the stored hash.
2. Pass the token to the booking provider only through an explicitly supported, privacy-reviewed provider mechanism; never rely on guest names, emails or fuzzy matching.
3. Authenticate webhook delivery with the provider's documented signature/authentication scheme and configured tenant/provider binding before calling the store.
4. Map only documented provider fields into `normalizeReservationEvent` and verify confirmed-state semantics in the provider sandbox.
5. Exercise real PostgreSQL concurrent replay and cross-tenant tests, plus duplicate delivery, cancellation, modification and expiry cases.
6. Keep booking association distinct from causal conversion. A token-linked confirmed reservation is evidence of a correlation, not proof that Veyra caused the booking.

Fixtures and test values are synthetic. No guest data, PMS credentials, live provider calls, production configuration changes, merge or deployment are involved.
