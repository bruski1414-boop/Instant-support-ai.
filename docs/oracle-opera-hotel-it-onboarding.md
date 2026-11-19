# Oracle OPERA / OHIP hotel integration onboarding

Status: **discovery checklist only; no live connection or credentials configured**.

## Why Oracle is the current target

Public Red Sea Global material names Oracle OPERA Cloud Central for Shebara. A Shebara Resort IT Officer listing also names OPERA PMS. This is sufficient to prioritise Oracle for technical discovery, but not to assume which OPERA modules, property configuration, OHIP tenant, API scopes, or integration permissions are enabled for Shebara.

## Hotel IT confirmation required

The hotel’s authorised IT/vendor owner should confirm, through an approved business channel:

- Exact product and deployment: OPERA Cloud PMS, OPERA Cloud Central, OPERA 5, or another configuration.
- Whether the property has an active Oracle Hospitality Integration Platform (OHIP) integration entitlement and a supported sandbox.
- Which API products and versions are enabled for this property, and the vendor-approved documentation for those exact APIs.
- Approved authentication flow, scopes, token lifecycle, IP/network requirements, and credential-vault requirements.
- Property/hotel identifiers and the authoritative mapping of room types, room categories, rate plans, occupancy limits, taxes, fees, deposits, cancellation policies, and local time zone.
- Whether availability, quote/rate retrieval, reservation creation, reservation lookup by external reference/idempotency key, modifications, and cancellations are supported and authorised.
- Vendor-side idempotency semantics and how ambiguous write outcomes must be reconciled.
- Approved synthetic test data, test cases, expected responses, rate limits, and sandbox reset process.
- Data controller/processor roles, approved privacy notice, retention/deletion schedule, audit requirements, and incident escalation contacts.
- Named hotel owner who can approve a pilot and sign off the test evidence.

## Credential and data handling

- Do not send passwords, client secrets, access tokens, guest details, or production payloads through ChatGPT, email drafts, tickets, or source control.
- Credentials must be provisioned directly by the hotel/vendor into an approved secret manager or credential vault.
- Development and CI tests must use synthetic data and mocked or vendor-approved sandbox responses.
- Do not enable production guest-data access until the hotel approves the integration, privacy controls, security review, and operational runbook.

## Veyra implementation sequence after approval

1. Confirm the exact Oracle product, API family, property identity, and vendor documentation.
2. Build a read-only adapter first for property configuration, room/rate mapping, and availability.
3. Validate date/time-zone boundaries, occupancy, room category, rate plan, taxes, and stale inventory behavior using sandbox tests.
4. Implement quote display and explicit guest acceptance against the hotel's approved policy.
5. Add reservation creation only after the vendor confirms supported idempotency and lookup/reconciliation behavior.
6. Run duplicate-request, timeout, partial-failure, tenant-isolation, privacy, and audit tests.
7. Obtain hotel IT and operations sign-off before enabling any live capability.

## Current Veyra status

- Oracle OPERA is listed in the provider registry as contract-only.
- A server-side, GET-only OHIP transport now exists in `opera-ohip-readonly-client.js`. It accepts a hotel-configured gateway, application key, hotel ID, and injected server-side access-token provider. It includes the documented OPERA Cloud v1 availability route (`GET /par/v1/hotels/{hotelId}/availability`) and validates stay dates, occupancy, room quantity and result limit. It returns the raw vendor response; it does not acquire tokens, map room/rate responses into Veyra's schema, or create reservations.
- The OHIP transport has synthetic unit tests for HTTPS, gateway path confinement, headers, query validation, non-JSON/oversized responses, sanitised HTTP errors, and the documented availability request shape. These tests do not prove connectivity to Shebara or Oracle's sandbox.
- No Oracle OPERA availability mapper, quote adapter, reservation writer, or live OHIP connection is implemented.
- The existing Mews transport is read-only and does not establish that Shebara uses Mews.
- The quote-consent workflow is provider-neutral and is not wired to a live PMS route.
- Booking readiness must remain false until every technical and hotel-approval gate is evidenced.
