# Hotel offer-conversion evidence and ROI reporting

## What the dashboard measures

The revenue-offers panel uses a rolling **30 × 24-hour UTC window**. The API returns the exact inclusive windowStart and exclusive windowEnd used for the report.

- **Offer enquiry records** count offer-attribution records created inside the window. One conversation can create more than one record if it asks about multiple offers.
- **Distinct conversations with offer enquiries** count unique Veyra conversation IDs in those records. This is an enquiry metric, not an influenced-conversation or conversion metric.
- **Evidence-referenced conversions** count completed offer sales whose hotel-entered evidence type, opaque evidence reference, positive amount, currency and sale timestamp are present, and whose sale timestamp falls inside the window.
- **Hotel-attested sale value** sums those evidence-referenced conversion amounts separately by currency, using each currency's minor-unit precision.
- **Legacy conversions without evidence** are retained for review but excluded from evidence-referenced conversion counts and value totals.

The window uses enquiry creation time for enquiry counts and the supplied sale time for conversion value. This avoids treating the date a staff member entered a record as the date the sale happened.

Offer prices shown in the editor and guest-answer context use the same currency-specific minor-unit precision. Zero-priced offers are allowed, while a converted sale must have a positive value.

## Evidence and attribution limits

A staff member must provide:
- the actual completed sale amount (not the advertised offer price);
- a supported ISO 4217 currency;
- the sale date/time with an explicit timezone;
- an evidence source type (pms_record, payment_receipt, invoice or hotel_report); and
- an opaque hotel record reference.

Do not enter guest names, email addresses, phone numbers, payment-card details or free-text guest notes as evidence references. Veyra validates the shape of the reference but does **not** fetch or independently authenticate the referenced hotel record.

These figures are therefore labelled **hotel-attested**, not independently verified payment revenue. A PMS record can establish a sale or booking state without proving that money was collected. A payment receipt reference is still only a hotel-entered reference until a provider integration verifies it. The dashboard must not describe these amounts as incremental revenue caused by Veyra.

Legacy converted records without complete evidence fields remain visible and are excluded from the evidence-referenced totals. An authorized staff member can add the missing evidence after checking the hotel's source record.

## Metrics that remain unavailable

- **Influenced conversations:** Not measured. A conversation-to-offer or conversation-to-sale link does not establish influence or causation. A hotel-approved definition and credible evaluation design are required.
- **Estimated staff time saved:** Not calculated. This requires a measured hotel baseline for comparable manual handling and validated evidence that the interaction avoided equivalent staff work.

Neither metric is populated with zero or a proxy.

## Safety and audit controls

- All reads and writes are scoped to the authenticated hotel organization.
- The existing owner/admin/staff role policy and session CSRF check remain in force.
- A conversion update locks the tenant-scoped attribution row and writes the updated evidence and audit record in one database transaction.
- The database adds a NOT VALID check constraint: existing legacy rows are not rewritten or deleted, while new and updated converted rows must include complete evidence fields.
- Evidence references are restricted to a bounded opaque-reference character set. Keep actual provider credentials out of records and logs.

## Current integration status

There is no provider-verified payment or offer-conversion adapter in this workflow. The current evidence flow is a manual hotel attestation backed by a reference the hotel can inspect. Synthetic integration fixtures are used in CI; no real guest, hotel, payment or PMS records are included.
