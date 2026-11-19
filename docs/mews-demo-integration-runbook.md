# Mews demo integration runbook

This integration is deliberately demo-only. It is not a live Shebara connection and must not be used for real guest bookings.

## Required hotel-side approvals and configuration

Obtain approval from the hotel's authorised PMS administrator before requesting or entering any credentials. The hotel must supply and approve:

- A Mews demo environment Client Token and Access Token, and an approved Client name.
- The correct Mews Service ID and Resource Category ID for the room inventory being tested.
- The property's IANA timezone (for example, `Asia/Riyadh`); do not infer it from the hotel's country.
- A documented, hotel-approved guest-profile resolver that maps an existing authorised Mews customer profile to a Customer ID. Do not create or search guest profiles without explicit hotel approval.
- A hotel-approved rate resolver that returns the correct Rate ID and exact property-local stay boundaries converted to UTC.
- A named hotel staff member responsible for reviewing uncertain reservation outcomes in Mews.

Never commit credentials, guest details, real booking references, or production configuration to Git. Store credentials only in an approved server-side secret store. Never expose them to browser code, chat responses, logs, issue comments, or test fixtures.

## What the current factory does

`createMewsDemoReservationIntegration` composes:
- A read-only Mews client for availability checks.
- A separately enabled writer that is restricted to the Mews demo API.
- A whole-stay availability adapter using hotel-supplied timezone boundaries.
- A PostgreSQL idempotency ledger scoped to the Veyra organization.
- A reservation writer that requires fresh matching availability, explicit consent to share guest details, and hotel-approved guest/rate mapping.

The writer does not itself authenticate hotel staff, select a tenant from a request, or provide an HTTP endpoint. Those controls must be added at the server boundary before the writer can be called by a dashboard or guest flow.

## Required server boundary before any UI integration

A future server route must:
1. Require an authenticated hotel owner/admin or explicitly authorised staff role; never accept an organization ID from the request body.
2. Resolve the tenant from the authenticated session and load only that tenant's encrypted demo credentials and approved mapping configuration.
3. Be disabled by default and refuse to start unless an explicit demo-only feature flag is enabled.
4. Require guest consent before sending guest name or phone details to Mews.
5. Validate request shape and apply rate limits, CSRF protection, tenant isolation, and audit logging.
6. Return only the minimum booking status/reference needed by the caller; never return credentials or raw provider payloads.
7. If a provider write has an ambiguous outcome, mark it uncertain and require staff reconciliation. Do not automatically retry.
8. Keep production credentials and production writes out of this demo integration.

## Sandbox acceptance checklist

- [ ] Hotel administrator confirms the Mews demo tenant and grants permission for the test.
- [ ] Correct Service ID, Resource Category ID, IANA timezone, and rate mapping are confirmed by hotel staff.
- [ ] Guest resolver maps only an already-authorised test guest profile.
- [ ] Availability response matches the exact property, room category, arrival, departure, and every night in the stay.
- [ ] Test a successful reservation using synthetic test guest details only.
- [ ] Verify the reservation appears in the Mews demo environment and its returned reference matches.
- [ ] Repeat the same idempotency key and verify no duplicate reservation is created.
- [ ] Simulate a timeout after the provider write and verify the request becomes uncertain and is not retried automatically.
- [ ] Verify missing consent, stale availability, wrong tenant, invalid dates, and mismatched room/rate mappings all fail closed.
- [ ] Hotel administrator signs off the sandbox result and the staff reconciliation procedure.

## Current release status

The Mews reservation writer and composition factory have automated mocked tests. The authenticated server route, hotel-specific secret/configuration storage, actual hotel-authorised Mews sandbox connection, and hotel acceptance test are not yet complete. A green CI run does not mean the hotel is connected or that bookings are operational.
