# Mews Connector API demo integration

Veyra now has a read-only Mews Connector API client in `mews-connector.js`.

## Supported demo calls

- `configuration/get`: verifies credentials and returns only the property's ID, name and timezone.
- `services/getAll`: reads service metadata with pagination.
- `services/getAvailability/2024-01-22`: reads service availability metrics for a bounded UTC interval.

The client uses the official Mews demo host only: `https://api.mews-demo.com`. It sends the required `ClientToken`, `AccessToken`, and `Client` fields in each JSON POST body. It does not expose a production host, mutate reservations, charge cards, change rates, or write to hotel operations.

## Local demo setup

Set these server-side environment variables in a private local environment only:

- `MEWS_CLIENT_TOKEN`
- `MEWS_ACCESS_TOKEN`
- `MEWS_CLIENT_NAME` (optional; defaults to Veyra AI/0.1)

Never commit credentials, send them in chat, put them in browser code, or add them to a public issue. Mews supplies demo credentials and demo properties in its developer documentation. Production credentials are environment-specific and require Mews' integration onboarding/certification process.

## What is not connected

No API call has been made from this repository because no credentials have been provisioned. No hotel account, live guest data, reservation feed or production environment is connected. The existing generic PMS canonical event layer remains separate from this read-only Mews client.

## Next steps before a supervised hotel pilot

1. Obtain Mews demo credentials through the official Mews documentation and configure them as private server environment variables.
2. Run the configuration check against the demo property.
3. Map the demo property's bookable service and resource categories.
4. Validate availability results against Mews Operations in the demo property.
5. Add signed/registered event ingestion and idempotent reservation sync only after reviewing Mews webhook registration requirements.
6. Complete Mews partner onboarding and certification before any production connection.
7. Obtain the hotel's written authorization, least-privilege credentials, privacy review and operational sign-off before using production data.

Official documentation:
- Getting started: https://docs.mews.com/connector-api/getting-started
- Authentication: https://docs.mews.com/connector-api/guidelines/authentication
- Services and availability: https://docs.mews.com/connector-api/operations/services
- API events/webhooks: https://docs.mews.com/connector-api/events
