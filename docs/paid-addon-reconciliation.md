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
