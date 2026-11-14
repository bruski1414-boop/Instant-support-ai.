# Mews Connector API demo integration

Veyra now has a read-only Mews Connector API client in `mews-connector.js`.

## Supported demo calls

- `configuration/get`: verifies credentials and returns only the property's ID, name and timezone.
- `services/getAll`: reads service metadata with pagination.
- `reservations/getAll/2023-06-06`: reads minimal reservation status/date summaries with optional incremental `UpdatedUtc` filtering.
- `getAllReservations()` and `getAllServices()`: safely follow Mews cursors up to a configurable page cap and report whether retrieval is complete.
- `services/getAvailability/2024-01-22`: reads service availability metrics for a bounded UTC interval.
- `services/getAvailability`: reads absolute availability counts for each resource category and time unit.
- `mews-live-context.js`: maps daily absolute availability into property-local, one-night canonical snapshots with a 10-minute freshness window. It refuses hourly/monthly services and mismatched category/time arrays.

The client uses the official Mews demo host only: `https://api.mews-demo.com`. Mews documents a maximum page size of 1,000 records; the client supports that limit and can fetch multiple cursor pages. The availability endpoint is documented as a restricted beta operation, and its timestamps must align with the bookable service's time-unit boundaries in the property's timezone. Veyra must derive those boundaries from the property's configured timezone and service metadata before relying on availability results. It sends the required `ClientToken`, `AccessToken`, and `Client` fields in each JSON POST body. It does not expose a production host, mutate reservations, charge cards, change rates, or write to hotel operations.

## Local demo setup

After setting the two required environment variables in a private local `.env` file, run `npm run mews:check`. The script performs a read-only configuration check and service-list request, then prints only the property summary and service count. It does not print credential values or request reservations.

Set these server-side environment variables in a private local environment only:

- `MEWS_CLIENT_TOKEN`
- `MEWS_ACCESS_TOKEN`
- `MEWS_CLIENT_NAME` (optional; defaults to Veyra AI/0.1)

Never commit credentials, send them in chat, put them in browser code, or add them to a public issue. Mews supplies demo credentials and demo properties in its developer documentation. Production credentials are environment-specific and require Mews' integration onboarding/certification process.

## Automated checks

A GitHub Actions workflow now runs on updates to this integration branch and pull requests targeting the PMS foundation branch. It installs the Node 20 dependencies and runs the repository's `npm test` syntax/unit-test suite. The result must be green before the pull request is considered ready to merge.

## What is not connected

No API call has been made from this repository because no credentials have been provisioned. No hotel account, live guest data, reservation feed or production environment is connected. The existing generic PMS canonical event layer remains separate from this read-only Mews client.

## Next steps before a supervised hotel pilot

1. Obtain Mews demo credentials through the official Mews documentation and configure them as private server environment variables.
2. Run the configuration check against the demo property.
3. Map the demo property's bookable accommodation service and resource categories.
4. Use `getMewsRoomNightSnapshots()` with service metadata, enterprise timezone, property reference and a bounded daily interval. Confirm returned local dates against the demo property. Each count is for one night only; it does not prove room availability for an entire multi-night stay.
5. Run a bounded reservation-summary query using a demo date window; reconcile statuses and stay dates against Mews Operations.
6. Add signed/registered event ingestion and idempotent incremental synchronization only after reviewing Mews event registration requirements.
7. Complete Mews partner onboarding and certification before any production connection.
8. Obtain the hotel's written authorization, least-privilege credentials, privacy review and operational sign-off before using production data.

Official documentation:
- Getting started: https://docs.mews.com/connector-api/getting-started
- Authentication: https://docs.mews.com/connector-api/guidelines/authentication
- Services and availability: https://docs.mews.com/connector-api/operations/services
- API events/webhooks: https://docs.mews.com/connector-api/events


## Tenant-specific encrypted connection setup

The admin API now supports one Mews demo connection per hotel workspace:

- `GET /api/admin/mews` returns connection metadata only; it never returns credentials.
- `PUT /api/admin/mews` accepts `clientToken`, `accessToken`, `serviceId`, `propertyReference`, and `timeZone` from an authenticated owner/admin over HTTPS. Tokens are encrypted with the existing AES-256-GCM server key before database storage.
- `POST /api/admin/mews/verify` performs read-only configuration and service checks. It confirms that the authenticated property ID and timezone match the saved hotel settings and that the selected service is active and daily.
- `DELETE /api/admin/mews` lets the workspace owner remove the connection and encrypted credentials.

The existing `STORAGE_TOKEN_ENCRYPTION_KEY` must be configured as a base64-encoded 32-byte key in the hosting secret manager. Never send Mews credentials in chat, commit them, place them in a browser bundle, or use credentials belonging to a different hotel. A hotel owner/operator should complete setup with an authorised adult platform operator supporting hosting configuration.

Only the official Mews demo endpoint is enabled. The hotel dashboard now provides a guided Mews setup flow: credential entry, encrypted save, read-only verification, connection status and owner-only disconnect. Saved credentials are never returned to the browser. Failed or expired verification remains retryable and never makes the connection eligible for guest availability.


## Guest chat full-stay availability

The public guest chat route can now accept an optional structured stay object alongside the guest message:

```json
{
  "message": "Can you check room availability?",
  "stay": {
    "arrivalDate": "2026-12-02",
    "departureDate": "2026-12-04"
  }
}
```

The widget reveals arrival and departure date fields when the guest asks about rooms or availability and sends them as `stay`. The server resolves only a connection whose status is `verified`, converts each property's local midnight to UTC, and requests all nightly inventory for the requested range. It reports the minimum inventory per room category across every night, never a single-night count as if it covered the whole stay. Requests over 30 nights, past dates, missing dates, incomplete provider responses, or API failures are not answered as available and are handed to staff.

This is an availability lookup only. It does not create a reservation, hold inventory, quote a rate, or confirm a booking. The actual widget flow and API still require an authorised hotel operator to connect and verify a Mews demo account before end-to-end testing. The dashboard does not accept production credentials; a verified demo account is required.


## Dashboard connection workflow

In the authenticated Hotel Setup panel, workspace owners and admins can:
- View whether a Mews demo connection is absent, awaiting verification, or verified.
- Enter the client token, access token, property/enterprise ID, daily accommodation service ID and property IANA time zone.
- Save credentials encrypted server-side. Token values are cleared from the form and are never returned by the status API.
- Run read-only verification of the authenticated property, configured timezone and active daily service.
- Re-verify an expired connection. Guest-facing use requires verification less than 30 days old.
- Disconnect the integration. Only the workspace owner can perform this action.

The dashboard hides raw provider error details and only displays a safe verification status. Credential setup requires server-side `STORAGE_TOKEN_ENCRYPTION_KEY`. A hotel owner/operator and authorised adult platform administrator should handle the real demo-account credentials and hosting configuration; never paste credentials into chat or commit them.
