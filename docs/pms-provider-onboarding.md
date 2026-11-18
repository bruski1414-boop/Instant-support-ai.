# PMS provider onboarding decision

Last reviewed: 15 November 2026

## Decision

Do not hard-code a default PMS vendor before the first pilot hotel is identified. Veyra's first production adapter should match the system the pilot hotel already uses. A hotel-specific integration is only real after the hotel's authorised sandbox connection passes read-only availability tests, booking lifecycle tests (if booking writes are in scope), webhook/event replay tests, and a staff-approved production cutover.

## Candidate platforms

| Platform | Relevant official capabilities | Access and onboarding considerations |
| --- | --- | --- |
| Oracle OPERA Cloud / OHIP | Reservation, rate, availability and inventory APIs; business events can be consumed through its Streaming API. | OAuth 2.0, application key, API scopes and enterprise/environment identifiers. Shared sandbox is available through OHIP. Partners need the relevant Oracle Hospitality integration subscription; hotel/environment owners must approve application and event access. |
| Mews Open API | Separate Connector, Booking Engine and Channel Manager APIs; demo environment and API documentation are available. | Client/app registration and partner onboarding are required for production. Some booking-engine functionality depends on the hotel's Mews plan and API permissions. |
| Cloudbeds | API coverage for reservations, rooms, availability, guest records and webhooks; staging environment includes synthetic data. | Sandbox access is subject to partner review. Production onboarding includes scoped credentials and integration certification. |

## Recommended implementation order

1. Ask the first pilot hotel which PMS it runs and whether it is cloud-hosted.
2. Ask the hotel's authorised IT/PMS administrator to sponsor an integration and provide a vendor-approved sandbox/test property.
3. Agree the minimum scopes: begin with read-only room types, rates and availability. Do not request guest-profile or payment scopes unless a specific approved workflow needs them.
4. Map the vendor's reservation and availability model into Veyra's normalized types.
5. Verify authentication, rate limits, retries, webhook signatures/event ordering, duplicate delivery, cancellation/modification, and tenant isolation in the vendor sandbox.
6. Only after hotel approval, perform a controlled production cutover with monitoring and a rollback plan.

## Current Veyra status

The provider-independent adapter contract, normalized availability/booking types, webhook verification primitives, idempotent tenant-scoped event inbox, encrypted credential vault, and dashboard status display are implemented.

There is **no production vendor adapter connected**. The built-in sandbox adapter is an interface test only. It does not return live room availability or create reservations. No hotel PMS credentials have been collected or stored.

The PMS connections table stores only encrypted credential material plus non-secret connection metadata. The dashboard status API does not return credential ciphertext or raw provider error strings. A separate PMS_CREDENTIAL_ENCRYPTION_KEY (base64-encoded 32-byte key) must be provisioned by an authorised adult/operator before a real provider connection is configured. Never commit this key or paste it into chat.

## Official references

- Oracle Hospitality Integration Platform: https://www.oracle.com/hospitality/integration-platform/
- Oracle OHIP authentication: https://docs.oracle.com/en/industries/hospitality/integration-platform/ohipu/c_authenticating_to_oracle_hospitality_property_apis_ocim.htm
- Oracle OHIP business-event streaming: https://docs.oracle.com/en/industries/hospitality/integration-platform/stmig/c_subscribing_and_consuming_events.htm
- Mews Open API: https://docs.mews.com/
- Mews getting started and demo environment: https://docs.mews.com/getting-started
- Cloudbeds partner integration guide: https://developers.cloudbeds.com/docs/integration-guide
- Cloudbeds sandbox request: https://developers.cloudbeds.com/docs/request-your-sandbox


## PMS credential encryption key operations

The current credential vault uses one active AES-256-GCM key and does not yet support automatic multi-key rotation. Replacing `PMS_CREDENTIAL_ENCRYPTION_KEY` before re-encrypting every stored connection will make existing credentials undecryptable.

For a planned rotation:

1. Have the authorised platform operator schedule a maintenance window and pause PMS operations.
2. Take and verify a protected database backup. Keep the old key available in the approved secrets manager; never put either key in GitHub, a ticket, or chat.
3. Run a reviewed migration process that decrypts each hotel's credential using the old key and encrypts it with the new key. Keep each update scoped by both `organization_id` and `provider`.
4. Verify every row can be decrypted with the new key and that no plaintext credential is written to logs, temporary files, or migration output.
5. Only after verification, update the runtime secret to the new key, restart the service, and test each provider connection with its authorised hotel administrator.
6. Retain the old key only for the approved rollback window, then revoke and securely destroy it under the operator's key-management policy.

Do not attempt an ad-hoc key replacement. A dedicated, tested rotation utility and recovery procedure are still required before production hotels rely on this vault.
