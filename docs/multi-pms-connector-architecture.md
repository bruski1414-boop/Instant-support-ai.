# Veyra PMS connector architecture

Status: **provider registry and tenant-scoped adapter framework added; vendor-specific live adapters are not yet implemented.**

## Design

Veyra uses one provider-neutral reservation workflow and a separate adapter for each PMS. The shared workflow must not contain vendor-specific endpoint assumptions.

The registry currently recognizes:

| Provider | Public API family | Documented integration surface | Veyra adapter status |
|---|---|---|---|
| Mews | Connector API, Booking Engine API, Channel Manager API | Availability, pricing and reservation operations vary by API family | Contract only |
| Cloudbeds | PMS and related APIs | Reservations, rooms, availability, guest profiles and events | Contract only |
| Apaleo | Booking, Distribution, Profile, Inventory and Webhooks APIs | Reservation lifecycle, offers and distribution bookings | Contract only |
| Oracle OPERA Cloud | OHIP | Requires property-specific OHIP access and scope review | Not assessed |

Official documentation:
- Mews: https://docs.mews.com/
- Cloudbeds: https://developers.cloudbeds.com/
- Apaleo: https://apaleo.dev/
- Oracle OHIP: https://docs.oracle.com/en/industries/hospitality/integration-platform/

## Important distinction

A provider being listed here does **not** mean Veyra can connect to it today. Each vendor has different authentication, permissions, property configuration, rate/room mapping, reservation semantics, rate limits and certification requirements. Some APIs expose booking creation only through particular API families or partner programmes.

The registry's `documentedCapabilities` are vendor documentation indicators, not tested Veyra capabilities. Runtime adapter availability is separate and tenant-specific.

## Adapter implementation contract

A vendor adapter must:
1. Authenticate using the vendor's supported OAuth/token flow and keep secrets in the server-side credential vault.
2. Bind credentials and every request to exactly one approved hotel tenant/property.
3. Map Veyra's normalized dates, occupancy, room type, rate plan, currency, tax and cancellation policy to the vendor's actual schema.
4. Return exact, timestamped inventory and rates; fail closed when any field is missing or stale.
5. Create, modify or cancel only when that capability is explicitly granted and tested.
6. Use vendor-supported idempotency or a safe reconciliation strategy before retrying uncertain writes.
7. Treat pending/unknown outcomes as pending and reconcile with the PMS before telling a guest anything is confirmed.
8. Subscribe to webhooks where available, verify signatures, and handle duplicate/out-of-order events.
9. Pass contract tests and vendor sandbox tests before pilot activation.

## Connection lifecycle

`discovered -> credentials_pending -> authorised -> sandbox_tested -> hotel_approved -> enabled`

Only the final state may be used for guest-facing live operations. An adapter cannot be registered in the runtime registry unless explicit hotel approval is supplied. Credentials must never be collected in guest chat or committed to source control.

## Delivery order

1. Mews: implement against the correct Mews API family after a partner/property sandbox is authorised.
2. Cloudbeds: implement OAuth and reservation/availability mappings after developer credentials and scopes are approved.
3. Apaleo: implement OAuth scopes, offers and Distribution/Booking API mapping in its developer environment.
4. Oracle OPERA Cloud (OHIP): assess the property's OHIP tenant, access programme and exact reservation/availability permissions before implementation.
5. Add other PMS vendors using the same adapter contract rather than modifying the core booking workflow.

## Mews implementation progress\n\nA first read-only Connector API transport exists in `mews-connector-client.js`. It supports configuration, services, service availability and reservation reads; credentials are injected at runtime, and requests are restricted to the official Demo or Production host. It deliberately exposes no reservation-write method. `mews-availability-adapter.js` now maps Mews category availability into a conservative whole-stay result by requiring every expected time unit and using the minimum availability across the stay. The hotel timezone/time-unit boundary mapping must be supplied from the property's approved configuration; the adapter refuses to guess. It is not yet wired into the reservation writer, and no live credentials have been configured. Mews Demo is public test data only; never send real guest information to it.\n\n## Not yet done

- No live vendor adapter is included in this change.
- No credentials, hotel guest data or production endpoint has been used.
- No provider certification or hotel approval has been completed.
- Shebara's actual PMS remains unconfirmed.
