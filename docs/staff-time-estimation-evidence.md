# Staff-time estimation evidence contract

## Status

This is a provider-neutral data-model and synthetic-test foundation only. It is not wired to the production dashboard or an HTTP route. No real hotel, employee, conversation or guest data was used.

## Metric definition

The only estimate produced by this contract is **potential staff minutes avoided (estimate)**.

For one eligible conversation:

potential minutes = hotel-attested median active handling minutes for the matching intent category

The estimate is intentionally conservative and requires all of the following:

1. A hotel owner/admin has attested a historical median active-handling-time baseline for the exact intent category.
2. The baseline identifies its source type, opaque evidence reference, sample count, sample window, attester, attestation time and review due time.
3. The baseline sample period ends strictly before the eligible resolution event; the baseline was attested strictly before that event and has not passed its review due time.
4. A trusted internal event-chain verifier confirms an explicit guest-confirmed-resolved event.
5. The same verifier confirms zero recorded staff messages/touches and zero staff escalations for that conversation.
6. The resolution event belongs to the same hotel and category as the baseline.
7. The event falls within the requested UTC reporting window, whose start is inclusive and end is exclusive.

The estimator never uses AI generation latency or staff first-response latency as a proxy for active handling time. Those are different measurements.

## Evidence and deduplication

- Baselines are marked hotel_attested, not independently verified. Only a SHA-256 hash of the hotel opaque evidence reference is retained by the model; callers must not supply guest or employee data as that reference.
- Resolution evidence is a verifier-created in-process capability; a plain JSON object or client-supplied verified flag cannot be used.
- Event IDs are deduplicated. Conflicting reuse of an event ID is excluded.
- A conversation with multiple distinct resolution events in one reporting window is excluded as ambiguous rather than counted twice.
- Cross-tenant and cross-category evidence is rejected.
- The output contains aggregate counts and minutes only; it does not expose conversation IDs or the hotel's opaque baseline evidence reference.
- No guest names, email addresses, phone numbers, transcripts or employee names are stored by this module.

## Reporting semantics

- With no baseline, the result is not_calculated, not zero.
- With no supplied eligible verified events, the result is not_calculated, not zero.
- When events are supplied, the result is estimated_partial and explicitly says coverage is limited to supplied verified events. Missing events are not interpreted as zero.
- The output is a counterfactual estimate. It is not observed staff time, payroll savings, cash savings, proof that Veyra caused the resolution, incremental revenue or ROI.
- No currency or wage conversion is performed.
- Sample count, source type and baseline status remain visible with the estimate.

## Integration blockers

The current main branch records AI replies, staff messages, escalations and staff first-response timestamps, but it does not record a distinct guest-confirmed-resolved event. A conversation with no escalation is not proof of resolution. The separate guest-resolution-feedback work is still a draft PR; its helpful signal must not be silently treated as a definitive resolved signal.

Before this contract can feed a hotel dashboard, a future change must:

1. Define an explicit optional guest action that means "my question is resolved", distinct from "that answer was helpful".
2. Verify the guest token, assistant-message ownership, tenant, event time and feedback deduplication on the server.
3. Query the internal message and escalation records to establish no staff touch and no escalation; never trust counts supplied by a browser.
4. Persist append-only resolution evidence with tenant-scoped uniqueness and audit history, respecting conversation deletion/retention rules.
5. Add an owner/admin baseline workflow that explains active handling time, category definitions, sample count and review date.
6. Only then expose an aggregate estimated_partial metric, with the disclaimer and exact reporting window.

No baseline has been configured for any real hotel. The synthetic fixture is explicitly labelled and must never be shown as a hotel result.
