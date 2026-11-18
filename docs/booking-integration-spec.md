# Veyra AI — hotel booking integration specification

**Status: design only. No booking connector is implemented.**

This document defines the requirements for adding real reservation capabilities. It is not evidence that Veyra can search inventory, hold rooms, create bookings, change reservations, cancel stays, or take payments.

## 1. Why a hotel system must be selected first

Hotels manage inventory and reservations through different property-management systems (PMS), central reservation systems (CRS), channel managers, and booking engines. Their APIs, authentication, permissions, sandbox access, and supported operations differ.

Before implementation, the hotel/operator must identify the exact system of record and approve its official integration route. Do not scrape a booking website, automate a staff login, invent an endpoint, or write directly to a hotel's database.

Required discovery:
- [ ] Name and version of the PMS/CRS/booking engine.
- [ ] Official API documentation and supported integration method.
- [ ] Vendor-approved sandbox/test property and credentials.
- [ ] Hotel-approved permissions and allowed operations.
- [ ] Whether availability, rates, room types, guest profiles, holds, create/update/cancel, and confirmation lookup are supported.
- [ ] Rate limits, webhook/event support, idempotency behavior, error semantics, and support contact.
- [ ] Adult/operator approval for vendor account, contract, credentials, costs, and data-processing terms.

Do not choose a vendor based only on popularity. Confirm the actual hotel uses it and that the vendor permits this integration.

## 2. Proposed adapter boundary

Keep provider-specific code behind a small internal interface. The AI model must never call a PMS directly and must never construct provider HTTP requests.

Proposed operations (only implement those officially supported by the chosen provider):
- `searchAvailability(criteria)` — read-only search with dates, occupancy, and approved room/rate constraints.
- `getOffer(offerReference)` — retrieve a current, provider-issued offer and its expiry.
- `createReservation(confirmedOffer, guestDetails, idempotencyKey)` — create only after the guest has reviewed and explicitly confirmed the exact details.
- `getReservation(providerReference)` — verify the authoritative reservation status.
- `changeReservation(providerReference, approvedChanges, idempotencyKey)` — only after explicit guest confirmation and hotel policy checks.
- `cancelReservation(providerReference, idempotencyKey)` — only after clear confirmation and presentation of any provider-returned cancellation terms.

The adapter must return typed results such as `available`, `unavailable`, `needs_staff`, `pending`, `confirmed`, `rejected`, or `unknown`. A timeout or ambiguous response is `unknown`, never `confirmed`.

## 3. Guest confirmation and truthful responses

Before creating or changing a reservation, show the guest a final summary of:
- hotel and property;
- arrival and departure dates;
- room type and occupancy;
- exact total price, currency, taxes/fees, and payment terms returned by the provider;
- cancellation/refund terms returned by the provider;
- guest details that will be sent;
- any provider-side expiry for the offer.

Require an explicit affirmative confirmation after the summary. Do not infer consent from earlier conversation, silence, or a vague statement.

After submission:
- Say "confirmed" only after a successful authoritative provider response and a verified reservation reference/status.
- If the request times out, returns an ambiguous result, or the confirmation lookup fails, say the status is not yet verified and route it to staff. Do not retry a non-idempotent create request blindly.
- Give the guest only the confirmation details returned by the provider.
- Never invent inventory, prices, discounts, policies, booking references, or completed actions.

## 4. Reliability and security requirements

- Use a server-side provider client; never expose vendor credentials to the browser or model.
- Store credentials in a dedicated encrypted secret store, with tenant-scoped access and rotation/revocation procedures.
- Use tenant isolation and least-privilege provider credentials wherever the vendor supports them.
- Use provider-supported idempotency keys for create/change/cancel operations; persist operation state before retrying.
- Add request timeouts, bounded retries only for safe/idempotent operations, rate limits, structured redacted logs, and alerting.
- Verify webhook signatures, timestamps, replay protection, and tenant ownership before processing provider events.
- Reconcile ambiguous outcomes by looking up the provider's authoritative reservation record.
- Do not log payment-card data, passwords, API keys, identity documents, or unnecessary guest personal data.
- Keep payment processing out of the first booking integration unless the hotel, provider, and qualified adult/operator explicitly approve a separate payment scope and compliant provider flow.

## 5. Required automated tests

Use only the vendor sandbox or deterministic fake adapter in CI. Never run tests against live hotel inventory.

- Availability results are tenant-scoped and reflect provider data, not AI guesses.
- Expired offers cannot be booked.
- A booking is not submitted until the guest explicitly confirms the exact summary.
- Duplicate requests with the same idempotency key do not create duplicate reservations.
- Timeouts and ambiguous provider responses never produce a success message.
- A confirmed message requires a verified provider reference and confirmed status.
- Cross-tenant references and credentials are rejected.
- Change/cancel requests require explicit confirmation and use provider-returned terms.
- Invalid, replayed, or cross-tenant webhooks are rejected.
- Provider outage, rate limiting, and authentication failure route safely to staff without claiming success.

## 6. Delivery sequence

1. Select and obtain written approval for one hotel's actual PMS/CRS/booking engine and its official sandbox.
2. Document the vendor API's exact supported capabilities and limitations.
3. Implement one provider adapter behind the interface above, with no model-generated direct API calls.
4. Add deterministic fake-provider tests and vendor-sandbox integration tests.
5. Run security/privacy review and a supervised test using synthetic guest data.
6. Only then consider a controlled pilot with explicit hotel approval and human oversight.

## 7. Out of scope for the first connector

Do not bundle payments, refunds, loyalty, channel distribution, room assignment overrides, identity verification, or broad guest-profile synchronization into the first connector. Keep the initial scope to availability lookup and a carefully confirmed reservation create flow if the selected provider supports both safely.
