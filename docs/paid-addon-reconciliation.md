# Paid add-on reconciliation contract (v1)

## Scope

`paid-addon-reconciliation.js` is a pure, read-only reconciliation function over canonical provider records. It makes no network calls and does not write to the Veyra revenue ledger. The fixtures in `tests/paid-addon-reconciliation.test.js` are synthetic and are not hotel results.

A future provider adapter must map fields using that provider's current documented API and approved scopes. Do not assume that similarly named fields exist in every PMS, and do not map from guest names, email addresses, free-text notes or display labels.

## Evidence required before an add-on is emitted

An item is reported as `addon_paid` only when all of these conditions hold:

1. It has a unique Veyra-issued external identifier in the `veyra-addon:` namespace.
2. It is linked to a reservation and has a closed accounting state.
3. Its linked bill is explicitly typed as a `Receipt` (not an `Invoice`).
4. The canonical adapter can link one or more `Charged` payments to that same bill, in the same currency, and their total covers the full bill amount.
5. The item amount is positive integer minor currency units and does not exceed the bill total.
6. Any refund or chargeback is separately confirmed, linked to the order item, in the same currency, and cannot exceed the original item amount.

The result reports the item's net amount after supplied confirmed adjustments, while preserving gross and adjustment amounts separately. Missing, incomplete, inconsistent or merely pending payment evidence produces no paid-revenue event. Duplicate identifiers and over-refunds are rejected rather than silently counted.

## Canonical adapter boundary

The function accepts normalized `orderItems`, `bills`, `payments` and optional `adjustments`. The provider-specific adapter is responsible for proving the relationships (including bill-to-payment linkage) from documented provider fields. The canonical `payment.billId` and `bill.totalAmountMinor` fields are Veyra's internal contract, not a claim that a provider exposes fields with those exact names.

For a Mews implementation, a later adapter must validate the current Connector API schemas and sandbox behaviour for order-item external identifiers, linked reservation IDs, bill type/amount, payment status and payment-to-bill association. The existence of a `Receipt` or a `Charged` payment in isolation is not enough if the adapter cannot prove they relate to the same bill.

## Reporting boundaries

- This contract covers paid add-ons only; it does not convert reservation totals into paid revenue.
- A confirmed reservation is booking evidence, not payment evidence.
- The output is an evidence object for a later ledger-ingestion step, not itself a dashboard total.
- The provider name must be supplied by a trusted configured adapter, not copied from untrusted event payload data.
- Tenant ID is required on every result; tenant-scoped persistence and ledger uniqueness must still be enforced by the caller.
- No real PMS, hotel, guest or payment data is used by these fixtures.
- No staff-time savings or causal conversion claim is calculated here.


## Existing ledger projection (v1)

`paid-addon-ledger-projection.js` maps a reconciled paid add-on into the existing revenue-event and revenue-adjustment request shapes. It preserves the original gross add-on amount as the event and projects confirmed refunds/chargebacks as separate adjustments, so the existing ledger computes net revenue without losing the audit trail.

This is deliberately a projection, not an automatic write. The caller must submit through the authenticated owner/admin ledger endpoints, where the server derives the tenant from the session and enforces duplicate references, tenant ownership, currency consistency and adjustment limits. The projection never supplies a conversation ID: provider reservation evidence does not prove that Veyra caused or influenced a booking. The ledger record therefore remains hotel-reported/unlinked unless an authorised hotel user separately attests a valid Veyra conversation link.

Synthetic tests cover gross/net reconciliation, separate refunds, incomplete evidence, tenant identity, zero-decimal currency and rejection of unverified records. No provider credentials, live PMS, guest data or production configuration are used.


## Revenue reporting windows

The authenticated owner/admin `GET /api/admin/revenue` endpoint defaults to a rolling 30-day window. It also accepts `startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` for an inclusive UTC calendar-date range. Both dates are required together; impossible dates, reversed ranges, future end dates and ranges longer than 366 inclusive days are rejected. SQL uses a half-open interval (start at UTC midnight, end at midnight after the selected end date) so the final selected day is included without timestamp overlap.

The same reporting window now constrains linked and unlinked totals, revenue event rows, adjustment rows (by the original revenue event's date) and linked-conversation counts. This is an event-cohort report: later refunds/chargebacks against an event in the selected period revise that event's net total and remain visible with their actual adjustment date. Currency totals remain grouped by currency; no FX conversion or cross-currency sum is implied. The endpoint's existing note continues to distinguish a hotel manager's conversation link from proof of causation. Default rolling windows retain their exact current timestamp boundaries.
