# Hotel offer attribution evidence and reporting

## What a conversion means

A conversion in this workflow is a **hotel-attested completed sale associated with an offer enquiry**. It is not independently verified by Veyra, and it does not prove the AI caused the sale or that the revenue is incremental.

Only a workspace owner or administrator may attest a completed sale. The record requires:
- a positive integer amount in currency minor units;
- a supported ISO 4217 currency;
- an evidence source (`pms_record`, `payment_receipt`, `invoice`, or `hotel_report`);
- an opaque evidence reference (never a URL, guest name, payment credential, or private note);
- a timezone-qualified sale timestamp on or after the enquiry.

The source reference is a hotel-supplied pointer. Veyra validates its shape, not the underlying provider record. A provider integration must independently authenticate and reconcile source data before it can be described as provider-verified.

## Immutability and deduplication

- A converted record cannot be reversed or have its amount, currency, evidence source, reference, or sale time overwritten.
- A repeated identical attestation is idempotent.
- Reusing the same evidence source/reference for a different sale in the same hotel is rejected.
- A refund or chargeback must be represented by a separate adjustment workflow; this feature does not calculate net revenue.
- The database constraint and trigger enforce evidence requirements even if an application route is bypassed.
- The conversion event and ordinary workspace audit entry are written in the same transaction as the attribution update.

## Reporting rules

The API returns a rolling 720-hour UTC window with an inclusive start and exclusive end:
- enquiry records and distinct enquiry conversations are counted by `created_at`;
- evidence-attested sales and their amounts are counted by `sold_at`;
- currencies are grouped separately and are never summed together;
- legacy conversions without complete evidence are excluded from revenue totals and shown as a separate all-time count.

The dashboard distinguishes enquiry records from distinct conversations and labels sale values as hotel-attested. **Influenced conversations are not measured. Estimated staff time saved is not calculated.** A linked enquiry is an association, not proof of causation.

## Permissions and privacy

Owners and administrators can view financial amounts, evidence references, and evidence history. Staff can view enquiry status and close an enquiry without a sale, but cannot attest revenue or access financial evidence. All queries are scoped to the authenticated organization; cross-tenant references return not found.

## Demo and pilot limits

Automated integration fixtures use synthetic hotels and synthetic evidence references. They prove application behaviour, database constraints, reporting-window boundaries, and tenant isolation only. They are not hotel results, payment verification, conversion benchmarks, or proof that Veyra earns a €2,000/month subscription fee.
