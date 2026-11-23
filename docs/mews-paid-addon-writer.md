# Mews paid add-on write intent and readback (v1)

## Status

This is a demo-only, server-side composition primitive. It is not connected to a live hotel, does not expose an HTTP route, and does not write to the revenue ledger. Automated tests use synthetic Mews-shaped inputs and mocked provider responses.

## Write safeguards

The writer accepts only a server-owned, active and hotel-approved Mews product. It deliberately uses `ProductOrders` rather than custom `Items`:

- The price remains the property's configured Mews product price; Veyra does not submit a price override.
- Exactly one product order is sent per operation, with a server-generated `veyra-addon:` external identifier.
- `LinkedReservationId` is set explicitly.
- The account identifier comes from a fresh, tenant- and Enterprise-matched reservation read; it is sent to Mews but is not persisted in the Veyra write ledger.
- The reservation must be `Confirmed` or `Started`, and its read must be no older than five minutes and still within its short validity period.
- The tenant-specific Mews connection must be verified, connected and in the demo environment.
- The client must explicitly declare the demo environment and write capability. Production clients are rejected.
- Guest text, notes, card data, amounts and raw provider responses are not stored in the idempotency record.

The request hash binds the tenant, Enterprise, service, product, reservation, account identifier and count. The tenant-scoped idempotency key prevents a repeated request from creating another Mews order. Reusing a key for different request data is rejected.

Mews Connector API does not document an idempotency-key parameter for `orders/add`. If the provider call times out, returns an invalid response, or succeeds but Veyra cannot commit the result, the request is marked `uncertain`. It is never automatically retried. Staff must reconcile the provider state before any new write is considered.

## Durable store and audit

`mews-addon-write-store.js` persists only:

- Veyra organization and idempotency key
- request SHA-256
- Mews Enterprise, Service and Reservation IDs
- generated external identifier
- state: `in_progress`, `completed` or `uncertain`
- returned Mews `OrderId`, when available
- a minimal provider-submission result and safe reason code

The PostgreSQL store uses tenant-scoped primary/unique keys and transactions. State transitions and append-only audit events commit together. The audit log records claim, provider-accepted and uncertain outcomes; it does not contain guest data or provider error bodies.

A completed write means only that Mews accepted an order and Veyra durably recorded its returned `OrderId`. It does **not** mean the item is closed, paid, reconciled, or eligible for revenue reporting.

## Why a separate readback is mandatory

Mews documents `orders/add` as returning an `OrderId`. Its `orderItems/getAll` response exposes an item's `ServiceOrderId`, and `productServiceOrders/getAll` exposes the product service order's `Id` and `LinkedReservationId`. The public contract does not state that `OrderId` and `ServiceOrderId` are interchangeable.

Veyra therefore does not equate them. `mews-addon-order-readback.js` requires:

1. The completed server-owned Veyra write record.
2. Complete pagination for order items and product service orders, queried through the verified tenant's Mews connection.
3. Exactly one order item with the exact server-generated external identifier.
4. Exactly one product service order matching that item's `ServiceOrderId`.
5. Matching Mews Service IDs and the exact submitted `LinkedReservationId`.
6. A non-cancelled product service order in an accepted state.

Only then does the readback verifier create the proof record consumed by `mews-paid-addon-adapter.js`. The mapper still independently requires the reservation to be currently confirmed and the order item, bill, payment and editable-history evidence to pass its accounting checks.

## Reporting boundary

The writer and readback verifier do not create revenue events. The paid-add-on mapper still requires a closed full-payment Receipt, qualifying Charged payment evidence, exact currency/minor-unit handling, complete correction/rebate coverage and elapsed editable-history windows. Refunds, chargebacks and corrective records remain withheld until item-level allocation is proven.

The resulting add-on evidence is `hotel_reported_unlinked`. No conversation ID, influence claim, causation claim or staff-time saving is inferred.

## Release gates

Before any real hotel use:

- Implement an authenticated owner/admin integration route that obtains tenant, connection, product and reservation data exclusively from trusted server-side stores and verified Mews reads.
- Add provider-specific readback pagination and safe retry/resume orchestration. An uncertain write must be reconciled, never replayed blindly.
- Obtain hotel IT approval and Mews-authorised non-production credentials; test against that hotel's exact product, account and service configuration.
- Complete security/privacy review and operational acceptance.
- Separately implement transactional ledger ingestion and safe refund/chargeback-to-item allocation.

No production connection, credential, guest record, payment record, or deployment is included in this PR.

## Official Mews references

- [Orders — Add order, ProductOrders, LinkedReservationId and ExternalIdentifier](https://docs.mews.com/connector-api/operations/orders)
- [Order items — ServiceOrderId and ExternalIdentifier](https://docs.mews.com/connector-api/operations/orderitems)
- [Product service orders — Id, ServiceId, State and LinkedReservationId](https://docs.mews.com/connector-api/operations/productserviceorders)
- [Upsell use case — posting hotel products to reservations](https://docs.mews.com/connector-api/use-cases/upsell)
