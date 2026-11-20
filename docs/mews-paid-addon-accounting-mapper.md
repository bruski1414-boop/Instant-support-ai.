# Mews paid add-on evidence mapper (v1)

## Status and scope

This branch adds a pure, read-only mapping layer from synthetic Mews Connector API-shaped records into Veyra's provider-neutral paid-add-on reconciliation contract.

- It makes no Mews API calls and performs no database writes.
- It uses synthetic test fixtures only; there are no hotel, guest, account or payment records.
- It does not create Mews orders or reservations.
- It does not write to the revenue ledger.
- It does not attach a Veyra conversation ID or claim that Veyra caused or influenced a sale.

The output is labelled `hotel_reported_unlinked`. It is provider evidence for later review, not proof of incremental revenue or a €2,000/month return.

## Required inputs from a trusted server-side Mews adapter

The mapper requires all of the following:

1. The organization ID from the authenticated Veyra tenant context.
2. The expected Mews Enterprise ID from the already verified tenant-specific connection.
3. The full Mews configuration response for that Enterprise, including `NowUtc`, `AccountingEditableHistoryInterval` and `OperationalEditableHistoryInterval`.
4. All pages of relevant order items, bills and payments.
5. Confirmation that corrective bills were included and that rebate chains were followed.
6. The currently confirmed reservation IDs, derived from a tenant-scoped Mews reservation read.
7. A server-owned order-to-reservation link record created only after a successful Mews `orders/add` request that included `LinkedReservationId`, paired with the returned `OrderId`.

The link record must carry the organization ID, Enterprise ID, Mews OrderId (the service-order identifier on returned order items), reservation ID and the fixed source label `mews.orders.add.LinkedReservationId`. The mapper rejects guest-supplied or cross-tenant link records. It does not infer a reservation from an arbitrary `ServiceOrderId`: Mews service orders can represent different service-order types.

## Evidence accepted

A Mews order item is eligible only if:

- Its `ExternalIdentifier` is in Veyra's `veyra-addon:` namespace and is unique in the batch.
- Its Mews Enterprise matches the tenant's verified Enterprise.
- Its service-order ID has a server-owned link to a reservation that is currently confirmed.
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

Mews accounting guidance recommends waiting until the longer of the accounting and operational editable-history windows has elapsed. The mapper reads both ISO-8601 duration values from the Enterprise configuration, computes each calendar-aware expiry from the bill's `PaidUtc`, and compares the later expiry with Mews' `NowUtc`.

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
- Server-owned reservation links and current reservation confirmation.
- Receipt versus Invoice and open bills.
- Corrective bills, bill rebates and chained item rebates.
- Editable-history windows and ISO-8601 duration handling.
- Charged payment state, signed amounts, currencies and refund/chargeback withholding.
- Exact minor-unit conversion for EUR, JPY and KWD.
- Duplicate identifiers, multiple add-ons on one bill, pagination gates and PII minimization.

## Remaining integration blockers

1. The current main branch does not yet contain a Mews `orders/add` add-on writer that persists the returned OrderId together with the submitted LinkedReservationId. The link record must be implemented as a tenant-scoped, idempotent, audited store before this mapper can be called in production.
2. A trusted adapter must fetch and paginate order items, bills, payments, reservations and all corrective/rebate records, then pass only the expected Enterprise's data.
3. Refund/chargeback evidence needs a safe original-payment-to-item allocation and final-state reconciliation.
4. A transactional, tenant-scoped ledger ingestion route must persist gross and adjustments with deduplication and an audit event in one transaction.
5. The resulting totals remain hotel-reported/unlinked until an authorised hotel owner separately attests a valid Veyra conversation association. Causation and staff-time-saved metrics need independent measurement.

No credentials, live Mews account, production configuration, hotel data or guest data are included.

## Official Mews API references

- [Orders — Add order and LinkedReservationId / ExternalIdentifier](https://docs.mews.com/connector-api/operations/orders)
- [Order items — Get all order items, ServiceOrderId, BillId, ExternalIdentifier, Amount and AccountingState](https://docs.mews.com/connector-api/operations/orderitems)
- [Bills — Receipt, Invoice, State and corrective-bill fields](https://docs.mews.com/connector-api/operations/bills)
- [Payments — BillId, signed Amount, State and Kind](https://docs.mews.com/connector-api/operations/payments)
- [Configuration — NowUtc and editable-history intervals](https://docs.mews.com/connector-api/operations/configuration)
- [Accounting use case — editable-history windows, reservation linkage and rebate chains](https://docs.mews.com/connector-api/use-cases/accounting)
