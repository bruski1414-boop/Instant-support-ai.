# Hotel offer attribution reporting

## Reporting window

The dashboard uses a rolling 30 × 24-hour UTC window. The API returns the exact windowStart and windowEnd; the start is inclusive and the end is exclusive.

- Offer enquiry records and distinct enquiry conversations are counted by created_at inside that window.
- Evidence-attested sale counts and amounts are counted by sold_at inside that window.
- Currency totals remain separate. No foreign-exchange conversion is performed.
- Legacy converted records without complete evidence are excluded from revenue totals. Their count is shown separately as an all-time figure because a trustworthy sale timestamp is unavailable.

## Evidence and attribution

A conversion requires a positive integer minor-unit amount, supported currency, timezone-qualified sale timestamp, supported evidence source and opaque hotel record reference. URLs and www. references are rejected; do not enter guest names, contact details, payment-card data, credentials, tokens or free-form notes as evidence references.

A hotel owner/admin attestation records that the hotel checked its own source. It does not independently authenticate the source record and does not prove that Veyra caused incremental revenue. A conversation association is not a causal attribution.

## Access

- Owners and administrators can view financial amounts, evidence references and audit history, and can attest completed sales.
- Staff can view offer-enquiry status and close an enquiry without seeing sale amounts or evidence references.
- Every write remains tenant-scoped, CSRF-protected and transactionally audited.
- Evidence-attested conversions are immutable; refunds or other adjustments require a separate auditable workflow.

## Metrics not yet measured

Influenced conversations are not measured. Estimated staff time saved is not calculated. Those metrics require agreed definitions, a hotel baseline and independently collected evidence. The dashboard must not substitute enquiry counts or linked sales for either metric.
