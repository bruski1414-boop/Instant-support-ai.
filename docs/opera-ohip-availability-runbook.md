# Oracle OPERA Cloud (OHIP) availability connector runbook

## Current implementation

Veyra includes a read-only OHIP transport, an availability adapter and a composition factory:

- `opera-ohip-readonly-client.js` sends GET requests only, using the configured gateway, application key, hotel ID and a server-side access-token provider.
- `opera-availability-adapter.js` converts a hotel-approved mapping of the raw OHIP availability response into Veyra's canonical availability shape.
- `opera-ohip-availability-integration.js` composes the client and adapter and registers the adapter for one approved tenant. It deliberately accepts only `environment: "nonproduction"`.
- The adapter exposes both `availability()` and `checkAvailability()` and can be registered with the provider-neutral PMS registry for the availability capability.

This is a read-only integration shell, not a verified Shebara connection. No hotel credentials, live property data, guest records or bookings are included.

## Before a hotel can connect

An authorised hotel administrator or Oracle integration administrator must confirm:

1. The property runs an eligible OPERA Cloud Foundation / OPERA Cloud Central environment and has OHIP access enabled.
2. The correct non-production environment, gateway URL, hotel ID, enterprise ID, scope and API subscription are known.
3. The application is registered in the appropriate OHIP Developer Portal and subscribed to the required Property API.
4. The OAuth token provider uses the hotel's approved authentication scheme and securely stores client credentials.
5. The hotel provides approved room-type/rate mappings and representative non-production response fixtures.
6. The hotel approves the data fields Veyra may request and the staff escalation process.

Do not ask hotel staff to send credentials through chat, email, GitHub issues or source files. Store secrets only in an approved server-side secret manager or encrypted credential vault. Never return tokens, application keys or raw provider error bodies to a browser or guest.

## Availability mapping

The adapter deliberately requires `mapAvailabilityResponse` to be injected. The raw OPERA response schema and availability semantics must be checked against the exact API subscription and hotel configuration in the hotel's own Developer Portal. The mapper must return:

- `organizationId`: the Veyra tenant ID supplied in the mapper context.
- `arrivalDate` and `departureDate`: exact dates from the request.
- `roomTypeCode`: the approved room-type code from the request.
- `roomsAvailable`: a non-negative safe integer representing whole-stay availability, not an unverified nightly sum.
- `observedAt` and `validUntil`: UTC timestamps no more than five minutes apart.

The adapter rejects tenant, date, room-type, inventory and freshness mismatches. Never infer a room category, rate plan or whole-stay availability from incomplete raw data.

## Safe development sequence

1. Use synthetic fixtures to test the adapter and provider registry.
2. Have an authorised adult and hotel/Oracle administrator provision non-production access.
3. Configure the server-side token provider and secrets without committing them.
4. Confirm the correct OHIP availability endpoint and response schema in the property's Developer Portal.
5. Validate the mapping with hotel-approved non-production responses.
6. Run bounded tests, review API usage, and keep the integration read-only until the hotel approves the next phase.

OHIP API usage can be billable even in sandbox/non-production environments. Do not run repeated polling or load tests without an approved usage budget and monitoring.

## Explicitly not implemented

- OAuth token acquisition/refresh; this is supplied as a trusted server-side callback.
- Hotel credential-vault routes or an authenticated admin setup screen for OPERA.
- Reservation creation, modification, cancellation, guest-profile writes or payment/deposit processing.
- A production mode or production credentials.
- A Shebara-specific mapping, property connection or hotel acceptance test.

## Release boundary

Keep this connector non-production and read-only. Do not merge, deploy, or connect real guest data until an authorised hotel administrator confirms the PMS and subscriptions, supplies approved non-production access, the exact response mapping is validated, security/privacy review is complete, and the hotel accepts the test results.
