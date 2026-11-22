# Mews paid add-on evidence mapper (v1)

## Status and scope

This branch adds a pure, read-only mapping layer from synthetic Mews Connector API-shaped records into Veyra's provider-neutral paid-add-on reconciliation contract.

- It makes no Mews API calls and performs no database writes.
- It uses synthetic test fixtures only; there are no hotel, guest, account or payment records.
- It does not create Mews orders or reservations.
- It does not write to the revenue ledger.
- It does not attach a Veyra conversation ID or claim that Veyra caused or influenced a sale.

The output is labelled `hotel_reported_unlinked`. It is provider evidence for later review, not proof of incremental revenue or a €2,000/month return.

## Transactional ledger persistence foundation

`paid-addon-ledger-store.js` adds a tenant-scoped PostgreSQL persistence boundary for the canonical mapper output.

- Each event is keyed by the hotel organization, Mews provider and Mews order-item ID, with a second tenant-scoped uniqueness constraint on the Veyra external identifier.
- An identical replay is counted as a duplicate. Reusing either identifier with different evidence causes the whole batch transaction to roll back.
- Event and audit rows are immutable. The event and its `paid_addon_ingested` audit row are committed together.
- Only allowlisted opaque provider IDs, integer minor-unit money, currency, payment evidence IDs and timestamps are persisted. Guest names, account details, notes, card data and conversation IDs are not copied.
- V1 accepts only fully paid, unadjusted add-ons and preserves `hotel_reported_unlinked`. Refunds and chargebacks remain withheld until an original-payment-to-item allocation is proven.

The store schema is initialized with the application database schema, but there is not yet an authenticated route or provider transport that invokes ingestion. The PostgreSQL integration test exercises two independent tenants, exact replay, conflicting-evidence rollback, privacy minimization and immutable audit/event rows. This is a persistence foundation, not a live Mews integration.

## Required inputs from a trusted server-side Mews adapter

The mapper requires all of the following:

1. The organization ID from the authenticated Veyra tenant context.
2. The expected Mews Enterprise ID from the already verified tenant-specific connection.
3. The full Mews configuration response for that Enterprise, including `NowUtc`, `AccountingEditableHistoryInterval` and `OperationalEditableHistoryInterval`.
4. All pages of relevant order items, bills and payments.
5. Confirmation that corrective bills were included and that rebate chains were followed.
6. The currently confirmed reservation IDs, derived from a tenant-scoped Mews reservation read.
7. A server-owned write record created only after a successful Mews `orders/add` request, containing the returned `OrderId`, submitted `LinkedReservationId`, tenant/Enterprise, and exact item-level `ExternalIdentifier`. The returned `OrderId` is retained as the Mews order reference; it is **not assumed to equal** an order item's `ServiceOrderId`.

The write record carries the organization ID, Enterprise ID, returned Mews `OrderId`, submitted reservation ID, service ID and exact Veyra external identifier. Mews documents `orders/add` as returning `OrderId`, while `orderItems/getAll` returns `ServiceOrderId` and `productServiceOrders/getAll` returns the product service order `Id` plus `LinkedReservationId`. Veyra therefore performs a separate readback: it finds exactly one order item by the exact external identifier, resolves that item's `ServiceOrderId` to one product service order, and verifies that service order's `LinkedReservationId` and service match the server-owned write record. It does not assume `OrderId === ServiceOrderId`. The mapper accepts only the resulting server-owned proof with source label `mews.orders.add+orderItems.getAll+productServiceOrders.getAll`. The proof includes the readback timestamp, current service-order state, provider update timestamp and explicit non-cancelled status. The mapper withholds a record if the readback is older than five minutes, is more than two minutes ahead of Mews' `NowUtc`, the service order is not in an accepted active state, or its provider update timestamp is later than the readback (with a two-minute clock-skew allowance). This prevents a previously valid but stale/cancelled service-order link from being reused as current paid-add-on evidence. Guest-supplied, spoofed, duplicate or cross-tenant links are rejected.

## Evidence accepted

A Mews order item is eligible only if:

- Its `ExternalIdentifier` is in Veyra's `veyra-addon:` namespace, is unique in the batch, and exactly matches a server-owned item-write record from the successful Mews order request.
- Its Mews Enterprise matches the tenant's verified Enterprise.
- Its service-order ID has a server-owned link to a reservation that is currently confirmed. The readback must also be no older than five minutes, show an accepted non-cancelled service-order state, and include an update timestamp no later than the readback time (allowing two minutes for provider clock skew).
- Its accounting state is `Closed`, it has a valid `ClosedUtc`, and it is not cancelled.
- Its current gross amount is positive and converts exactly to integer minor units using the ISO 4217 currency precision. The mapper does not round unsupported fractional precision.
- It belongs to a closed bill whose type is `Receipt`, correction state is `Bill`, and `Options.Rebated` is explicitly false.
- The bill has not been superseded by a corrective bill and the item has no direct or chained rebate evidence.
- The bill has a `PaidUtc` timestamp and the longest of the accounting and operational editable-history intervals has elapsed.
- At least one linked payment is `Kind=Payment`, `State=Charged`, `AccountingState=Closed`, negative in Mews' signed amount convention, and in the same currency as the bill's order items.

Mews documents a closed `Receipt` as a bill paid in full with zero balance. The bill response does not expose a canonical total amount or currency field. The mapper therefore uses the Receipt status as explicit paid-in-full evidence, derives a bill currency only when all returned order items and qualifying charged payments agree, and withholds mixed or incomplete bills rather than inventing a total.

## Refunds, chargebacks and corrections

Mews exposes `Payment.Kind` values including `Refund`, `Chargeback` and `ChargebackReversal`. An active adjustment kind blocks all Veyra add-ons on that bill for manual reconciliation. The mapper does not allocate a payment-level refund across one or more order items.

Mews' refund operation returns both the original `PaymentId` and a `RefundId`, but a generic refund/chargeback record is not sufficient to allocate an adjustment to a particular add-on when a bill contains multiple items. A future adjustment adapter must prove the original-payment relationship, final state and item allocation before creating a ledger adjustment. Until then, the affected bill is withheld.

Corrective bills, bill-level rebates, and item-level rebate chains are also withheld. Mews documents that rebate items refer to the rebated order item and that rebate chains may need recursive lookup. The caller must set the coverage flags only after fetching all pages and resolving those chains.

## Editable-history finality

Mews accounting guidance recommends waiting until the longer of the accounting and operational editable-history windows has elapsed. The mapper reads both ISO-8601 duration values from the Enterprise configuration. Its conservative finality anchor is the latest of the bill's `PaidUtc`, optional `IssuedUtc`, required `UpdatedUtc`, and the order item's required `ClosedUtc` and `UpdatedUtc`. It computes each calendar-aware expiry from that anchor and compares the later expiry with Mews' `NowUtc`. Missing required update timestamps are withheld.

Records inside the editable-history window are withheld. Unsupported or missing configuration is an error, not an assumption. A later correction, rebate or chargeback discovered during a subsequent reconciliation must cause the corresponding event to be revised through an auditable ledger adjustment; this mapper does not implement that persistence.

## Deduplication and tenant isolation

- Duplicate Mews row IDs are rejected.
- Duplicate Veyra external identifiers are rejected.
- Every order item, bill and payment must belong to the exact expected Mews Enterprise.
- Every reservation link must belong to the exact Veyra organization and Mews Enterprise.
- A service order cannot have multiple reservation links.
- The caller must fetch all pages and corrective/rebate evidence before calling the mapper.
- The mapper returns only opaque provider IDs, money, currency, timestamps, evidence references and withholding reason codes. It discards names, email addresses, notes, account details and payment-card data.

The mapper is not a substitute for tenant-scoped database uniqueness, authenticated owner/admin access, transactional audit logging or row-level security when ledger persistence is added.

## Reporting and attribution rules

- A paid add-on event is based on provider evidence for a Veyra-issued order item and a paid Mews Receipt.
- The gross amount is the order item's current positive gross amount, not its net-of-tax amount.
- Refunds, chargebacks, corrective bills and rebates are not silently netted or ignored; affected records are withheld until item-level allocation is proven.
- Currency totals must remain separate. No FX conversion is performed.
- The projection deliberately omits `conversationId` and returns `hotel_reported_unlinked`.
- A confirmed reservation is not payment evidence by itself.
- A Veyra conversation link is not proof of causation, incremental lift or staff time saved.

## Synthetic fixtures and tests

`fixtures/mews-paid-addon-accounting.js` contains fictional API-shaped records. Tests cover:

- Valid paid add-on mapping.
- Cross-enterprise and cross-tenant rejection.
- Server-owned reservation links, current reservation confirmation and fresh active service-order readback.
- Stale readback, future service-order updates, canceled service orders and unsupported service-order states.
- Receipt versus Invoice and open bills.
- Corrective bills, bill rebates and chained item rebates.
- Editable-history windows and ISO-8601 duration handling.
- Charged payment state, signed amounts, currencies and refund/chargeback withholding.
- Exact minor-unit conversion for EUR, JPY and KWD.
- Duplicate identifiers, multiple add-ons on one bill, pagination gates and PII minimization.

## Remaining integration blockers

1. This PR adds a demo-only `orders/add` writer, tenant-scoped idempotency/audit store and pure readback verifier. They are not yet wired into an authenticated server route or live hotel connection. A reviewed integration composition and owner/admin route with explicit hotel approval remain required before use.
2. A trusted adapter must fetch and paginate order items, bills, payments, reservations and all corrective/rebate records, then pass only the expected Enterprise's data.
3. Refund/chargeback evidence needs a safe original-payment-to-item allocation and final-state reconciliation.
4. A transactional, tenant-scoped ledger ingestion route must persist gross and adjustments with deduplication and an audit event in one transaction.
5. The resulting totals remain hotel-reported/unlinked until an authorised hotel owner separately attests a valid Veyra conversation association. Causation and staff-time-saved metrics need independent measurement.

No credentials, live Mews account, production configuration, hotel data or guest data are included.

## Official Mews API references

- [Orders — Add order and LinkedReservationId / ExternalIdentifier](https://docs.mews.com/connector-api/operations/orders)
- [Order items — Get all order items, ServiceOrderId, BillId, ExternalIdentifier, Amount and AccountingState](https://docs.mews.com/connector-api/operations/orderitems)
- [Product service orders — service-order Id, State, ServiceId and LinkedReservationId readback](https://docs.mews.com/connector-api/operations/productserviceorders)
- [Bills — Receipt, Invoice, State and corrective-bill fields](https://docs.mews.com/connector-api/operations/bills)
- [Payments — BillId, signed Amount, State and Kind](https://docs.mews.com/connector-api/operations/payments)
- [Configuration — NowUtc and editable-history intervals](https://docs.mews.com/connector-api/operations/configuration)
- [Accounting use case — editable-history windows, reservation linkage and rebate chains](https://docs.mews.com/connector-api/use-cases/accounting)
