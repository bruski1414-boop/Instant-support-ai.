# Mews live room quotes

This guide covers the current Mews Connector API integration in Veyra.

## Prerequisites

- A hotel-owned Mews Connector API Client Token and Access Token.
- Permission from the hotel to connect its Mews environment to Veyra.
- The hotel's accommodation service ID.
- A mapping for each guest-facing room type: Veyra room ID/name, Mews rate ID, Mews resource category ID, adult age category ID, and maximum occupancy.
- The hotel's IANA timezone and local check-in/check-out times.

Only an authorised hotel owner or administrator should configure production credentials. Veyra stores the credentials in its encrypted PMS credential vault. Never put credentials in guest chat, support tickets, source code, or public configuration.

## Dashboard setup

1. Sign in to the hotel's Veyra dashboard as an owner or admin.
2. Open Hotel setup and find the Mews connection panel.
3. Enter both Mews credentials, then the accommodation service ID and hotel timezone (for example, `Asia/Bangkok`).
4. Add one room mapping for every room category the hotel wants to offer.
5. Submit the form. Veyra validates the credentials against Mews, records a connection test, then saves the room mappings.
6. Confirm that the PMS connection is shown as connected and that the hotel's production readiness checks are complete.

The current Mews adapter intentionally supports daily accommodation services only. Hourly and monthly services are rejected rather than interpreted incorrectly.

## Guest-facing quote endpoint

`POST /api/public/:slug/availability`

Request:

```json
{
  "checkIn": "2027-12-10",
  "checkOut": "2027-12-13",
  "guestCount": 2
}
```

Veyra checks the hotel's live Mews daily inventory for every occupied night, applies each returned relative availability adjustment, and requests reservation pricing for each eligible mapped room type. The quote uses Mews' gross amount plus separately returned additional expenses, such as city tax.

A successful response contains `verified: true` and an `options` array. Each option includes a Veyra quote ID, room type, currency, total amount in currency minor units, available unit count, and expiry timestamp. Quotes expire after five minutes.

The guest widget now includes a “Check room availability” form and displays these quotes. It clearly tells the guest that a quote is not a confirmed reservation.

## Important booking limitation

The guest-facing quote flow is connected. A complete public booking transaction is not yet enabled: payment-provider checkout, signed payment webhooks, durable booking-intent orchestration, deposit verification, PMS reservation creation, and final confirmation still need to be connected and tested end to end.

The Mews reservation adapter has a booking method and explicitly keeps Mews' overbooking and rate-applicability checks enabled. That adapter capability alone does not mean a guest can complete a booking through the public widget.

Do not tell a guest a room is reserved until a payment provider has verified the required payment and Mews has returned a confirmed reservation with a real confirmation reference.

## Verification

The GitHub Actions workflow runs `npm test` on Node.js 20. The Mews tests use mocked API responses; they do not replace a live hotel test using the hotel's authorised Mews test environment and real property mappings.

Official Mews references:

- [Services and availability](https://docs.mews.com/connector-api/operations/services)
- [Reservations and pricing](https://docs.mews.com/connector-api/operations/reservations)
- [Mews API operations](https://docs.mews.com/connector-api/operations)
