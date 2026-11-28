# Mews PMS integration plan

Status: research and implementation contract only. No live Mews adapter is enabled by this document.

## Official API facts checked

- Mews Connector API requests are HTTP POST with JSON and require `ClientToken`, `AccessToken`, and `Client`.
- Mews supplies a demo environment and demo credentials; production use follows Mews integration/certification requirements.
- `services/getAvailability/2024-01-22` returns resource-category availability by time unit. Its metrics include usable resources, active resources, occupied resources, and confirmed reservations.
- `reservations/price` requires a service, date interval, requested resource category, rate, and person counts; it returns `TotalAmount` and additional expenses.
- `customers/add` creates a customer profile. `reservations/add` creates reservations; a successful API call alone must not be treated as guest confirmation until the returned reservation is independently checked and the PMS result is persisted.

Official references:
- https://docs.mews.com/connector-api/getting-started
- https://docs.mews.com/connector-api/guidelines/requests
- https://docs.mews.com/connector-api/operations/services
- https://docs.mews.com/connector-api/operations/reservations
- https://docs.mews.com/connector-api/operations/customers

## Required hotel-specific mapping

A Mews connection will need hotel-authorized credentials and property configuration, stored encrypted per tenant:

- Mews ClientToken (Veyra integration identity, issued by Mews)
- Property AccessToken (issued/authorized by the hotel)
- approved Mews API environment
- EnterpriseId where required
- accommodation ServiceId
- resource-category IDs mapped to Veyra room types
- rate IDs and guest age-category IDs needed to price reservations
- hotel timezone and check-in/check-out offsets

Do not infer any of these IDs from room names or guest text. They must be obtained from the hotel's authorized Mews configuration and validated.

## Safe implementation sequence

1. Add a Mews adapter with a strict host allowlist for Mews demo/production API hosts, bounded request timeouts, bounded response sizes, and credential validation.
2. Test the connection using Mews `configuration/get`; never log tokens or raw credential payloads.
3. Read the property's service, resource-category, rate, and age-category configuration. Require an explicit tenant mapping before enabling room quotes.
4. Calculate the property's local date boundaries using the configured hotel timezone and Mews service offsets; do not assume UTC midnight equals local check-in.
5. Query availability and price from Mews. Persist a short-lived Veyra quote only when both inventory and a valid rate are confirmed.
6. After a verified 50% deposit, create the customer and reservation using the persisted quote's details, not client-supplied prices or room IDs.
7. Verify the resulting reservation through a follow-up Mews read. Only a confirmed PMS state plus a persisted reservation reference may produce guest-facing confirmation.
8. Treat timeouts after a write as ambiguous. Do not retry reservation creation automatically; route to staff reconciliation to prevent duplicate bookings.
9. Add demo-environment contract tests and tenant-isolation tests before enabling any capability.

## Current Veyra limitations

- The active PMS registry still contains only the sandbox adapter.
- No Mews credentials, hotel mappings, or production adapter are connected.
- The current generic quote schema assumes one quote amount/currency. Mews pricing may return additional expenses separately; the implementation must explicitly decide whether those are included in the guest-facing total before enabling deposits.
- The current booking orchestration's generic idempotency key does not, by itself, guarantee that Mews deduplicates a create request. Ambiguous write outcomes must remain staff-review cases.
- No live payment checkout provider is enabled either.

## Approval and access boundary

A hotel must authorize access to its own Mews property and approve the integration. A parent/guardian should handle any business agreements, account ownership, billing, and real hotel credentials. Until then, development should use mocked responses or Mews demo credentials only, with no real guest data.
