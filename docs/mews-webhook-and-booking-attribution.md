# Mews webhook intake and guest booking attribution (v1)

## Implemented in this branch

### Mews General Webhook intake

- `mews-webhook.js` verifies the configured shared URL secret using SHA-256 digests and constant-time comparison.
- The receiver accepts the documented General Webhook envelope: `EnterpriseId`, `IntegrationId`, and `Events`.
- It accepts only `ServiceOrderUpdated` entity references for queueing. Other event types are counted and ignored.
- Tenant assignment is derived server-side by matching the webhook's `EnterpriseId` to exactly one verified `mews_connections.property_reference`. The request cannot supply an organization ID.
- Only integration, enterprise, discriminator and entity identifiers are stored in `mews_webhook_inbox`. No raw payload, guest name, email, phone, payment or note data is retained.
- The endpoint responds with HTTP 202 after queue persistence. It does not call Mews during the webhook request.

### Guest-facing correlation token issuance

- `POST /api/public/:slug/conversations/:id/booking-attribution` requires the guest conversation token and checks that the conversation belongs to the hotel workspace.
- Current hotel privacy approvals and guest-data-storage enablement are required.
- `BOOKING_ATTRIBUTION_ENABLED=true` is required before token issuance can be used.
- A 256-bit opaque token is returned once; only its SHA-256 hash is stored. Issuing a replacement invalidates the previous unused token for that conversation.
- Rate limiting is applied. The token is not a guest identifier and must not be put into a URL or ordinary guest notes.

## Mews Connector security facts and limitations

The Mews Connector API Webhooks FAQ documents a shared secret token in the webhook URL. It does not document an `X-Signature` HMAC header for Connector API General Webhooks. The HMAC scheme documented for Mews POS webhooks must not be assumed to apply to Connector API.

Mews General Webhooks contain `EnterpriseId`, `IntegrationId`, and event discriminators with an entity `Id`. For `ServiceOrderUpdated`, the receiver must fetch the full reservation using the Connector API. Mews says webhook receivers should respond within five seconds and recommends asynchronous processing for additional API calls.

Operational requirements:
1. Set `MEWS_WEBHOOK_TOKEN` to a random secret of at least 32 bytes, encoded as base64url.
2. Set `MEWS_INTEGRATION_ID` to the exact integration UUID registered with Mews.
3. Register `https://YOUR_HOST/api/integrations/mews/events?token=YOUR_SECRET` with Mews support.
4. Ensure the hosting proxy, access logs, APM and error reporting redact the entire `token` query parameter. If this cannot be guaranteed, do not enable the endpoint.
5. Keep the receiver disabled until the integration ID, webhook registration, tenant mapping and log redaction are independently verified.

## Explicitly not yet implemented

- The inbox is an intake queue only. There is no worker in this branch that claims inbox rows, calls Mews, fetches reservation details, retries failures or marks events processed.
- No provider-specific Mews reservation metadata field for the Veyra attribution token is documented in the current public Reservation contract. The token therefore cannot currently be matched to a Mews reservation through a supported private metadata field.
- Do not put the token into Mews guest-visible notes, `OriginDetails`, `ChannelNumber`, or another operational field as a workaround.
- No booking is attributed by the webhook receiver. It only queues a reservation entity reference.
- No live Mews credentials, hotel sandbox, guest data or production webhook registration were available or used.

The next implementation step is a background inbox processor that fetches reservation state through the read-only Connector API, safely records provider state without PII, and leaves attribution unmatched unless Mews or the hotel approves a documented private token-correlation mechanism. A hotel pilot additionally requires Mews partner certification/production access and hotel authorization.

## Official Mews references

- [Webhooks FAQ](https://docs.mews.com/connector-api/events/wh-faq) — shared URL secret, delivery retry and five-second response requirement.
- [General Webhooks](https://docs.mews.com/connector-api/events/wh-general) — event envelope and `ServiceOrderUpdated` entity identifier.
- [Reservations](https://docs.mews.com/connector-api/operations/reservations) — reservation retrieval contract and confirmed state.
- [Connector API authentication](https://docs.mews.com/connector-api/guidelines/authentication) — client and property access tokens.
