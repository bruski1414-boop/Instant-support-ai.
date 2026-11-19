# Veyra hotel revenue and guest-operations product scope

## Product promise

Veyra is an AI guest-operations and revenue platform for hotels. It should help a hotel convert more guest demand, handle routine guest interactions, coordinate service requests and measure incremental commercial value. It is not merely an FAQ chatbot or a promise to eliminate staff.

## 1. Direct room reservations

Guest flow:
- Understand requested dates, occupancy, room preferences and required accessibility/other constraints.
- Query the hotel's authorised booking/PMS system for current availability, rates, taxes, fees, restrictions and cancellation terms.
- Present a complete quote with an expiry time.
- Ask the guest to confirm the exact room, dates, occupancy, total price, deposit and terms.
- Collect only the guest details required by the hotel.
- Create an idempotent provisional hold if the provider supports it.
- Send hosted checkout for the hotel's configured deposit amount (50% is a configurable pilot policy, not a universal rule).
- Verify signed payment events server-side and reconcile payment status.
- Confirm the reservation through the PMS/booking provider.
- Send a confirmation only after the provider returns confirmed status and a reservation reference.
- Handle expiry, payment failure, price/availability changes, duplicate webhooks, cancellation and staff escalation.

## 2. Ancillary bookings and purchases

Support hotel-approved products and services such as:
- Restaurant tables and dining packages.
- Spa treatments.
- Airport transfers.
- Activities and excursions.
- Late checkout, early check-in and room upgrades.
- Other property-defined services.

For each category, Veyra must query the relevant live availability, capacity, price, restrictions and booking rules. It must obtain guest confirmation before any charge or commitment, use secure hosted payment where payment is required, create the service booking in the authoritative hotel system, and only then confirm it to the guest. If no connected system exists, route the request to staff and label it pending rather than claiming it is booked.

## 3. Guest support and operations

- Answer questions from complete, current, hotel-approved knowledge.
- Support multiple languages with clear fallback when uncertain.
- Categorise and route housekeeping, maintenance, concierge, food-and-beverage and complaint requests.
- Create trackable staff tasks with priority, owner/team, timestamps and status.
- Send guest acknowledgements that distinguish received, assigned and completed.
- Escalate emergencies, safety issues, complaints requiring judgement and all low-confidence cases to staff.
- Track unresolved work and follow-up deadlines.
- Never invent that a request has been fulfilled.

## 4. Revenue intelligence

A hotel dashboard should report:
- Enquiries and conversations by channel.
- Quotes issued and bookings created.
- Reservations confirmed and deposits actually collected.
- Ancillary service purchases.
- Room upgrades and other offers accepted.
- Conversion rate by source and journey.
- Incremental revenue and, where the hotel supplies costs/margins, estimated incremental gross profit.
- Refunds, cancellations, chargebacks and booking reversals.
- Staff escalations and resolution outcomes.

Attribution must be conservative and auditable. Distinguish bookings merely assisted by Veyra from genuinely incremental bookings. Do not count gross booking value as profit. Do not claim savings without a documented baseline and evidence of avoidable costs actually removed.

## 5. Operational efficiency reporting

Measure:
- Routine interactions automated end-to-end.
- Staff minutes saved using an agreed baseline and sampling method.
- Repetitive task volumes shifted from staff to automation.
- Overtime, temporary staffing or other costs actually avoided, where the hotel validates them.
- Human handoffs, rework, mistakes and guest satisfaction.

Veyra should help hotels make informed staffing decisions, not promise headcount reductions. Hotels remain responsible for adequate human coverage, emergencies, in-person hospitality, complex requests and legal employment obligations.

## 6. Reliability, security and administration

- Tenant-isolated data, role-based permissions and encrypted credentials.
- Minimise personal data; defined retention, deletion, access and audit processes.
- Secure hosted payments; never store raw payment card details in Veyra.
- Signed webhooks, idempotency, retries, reconciliation and observability.
- Human override, pause/disable controls and documented incident response.
- Per-property configuration for rates, deposit rules, cancellation terms, approved offers, service hours and escalation contacts.
- Integrations must use documented vendor APIs and hotel-authorised credentials.
- No live guest data or real payments in development tests.

## 7. Proof required before commercial launch

- Vendor-specific integration tested against an authorised PMS demo/sandbox and then an authorised hotel pilot.
- End-to-end tests for room booking, deposit payment, provider confirmation, cancellation/refund and failure recovery.
- End-to-end tests for at least one ancillary service workflow.
- Staff task routing and resolution verified with hotel staff.
- Tenant-isolation, permissions, security and privacy review.
- Load, reliability, monitoring and support runbooks.
- Hotel-approved baseline and pilot report demonstrating booking conversion, actual incremental margin, service quality and validated operating savings.

## Current state

This is the target product scope, not a statement that these capabilities are already implemented. The current code includes existing guest-support, staff-escalation, PMS framework and new booking/deposit domain primitives. Live vendor-specific booking, payment processing, ancillary-service integrations, operational task completion and verified ROI reporting remain to be implemented and tested. Do not claim the full product is available until the proof requirements above are met.
