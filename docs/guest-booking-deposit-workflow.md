# Guest booking and 50% deposit workflow

## Guest experience

1. The guest tells Veyra the dates, room type and number of guests.
2. Veyra retrieves live availability and a total price from the hotel's connected booking/PMS provider. It must not invent availability, rates, taxes or fees.
3. Veyra presents the exact room, dates, guest count, total price, cancellation terms and 50% deposit amount.
4. The guest explicitly confirms those exact details.
5. Veyra collects the guest's name and phone number (and email only if required by the hotel).
6. The provider's supported reservation-hold operation creates a time-limited provisional reservation under the guest's name. If the provider cannot safely hold inventory, Veyra must disclose that the room is not held while payment is pending.
7. A PCI-compliant payment provider creates a hosted checkout session for exactly 50% of the quoted total. Veyra must not collect or store card numbers, security codes or bank credentials.
8. Veyra waits for a signed, verified payment event. A browser redirect or guest statement is not proof of payment.
9. After payment is verified, Veyra asks the PMS/booking provider to confirm the held reservation. Only the provider's confirmed reservation ID/status permits Veyra to tell the guest the booking is confirmed.
10. If payment expires/fails or provider confirmation fails, Veyra must accurately report the state, release the hold when supported, and trigger staff follow-up/refund handling as required.

## Required provider capabilities

A production booking adapter must document and test:
- Live availability and a quote with currency, taxes/fees and quote expiry.
- A time-limited reservation hold under the guest's name, including hold expiry.
- Idempotent hold creation, confirmation and cancellation/release.
- Final confirmation after payment, with provider reservation ID and confirmed status.
- Availability/price revalidation at the point the hold is created.
- Webhook signature verification and reservation/payment status reconciliation.
- Cancellation, failed-payment, duplicate-event and timeout behavior.

A payment adapter must document and test:
- Hosted checkout creation for the exact deposit amount and currency.
- Signed webhook verification using the provider's documented signature scheme.
- Idempotent event processing and payment reconciliation.
- Refund handling and a clear audit trail.
- No card data entering Veyra logs, transcripts or database.

## Safety and correctness rules

- Guest confirmation must cover the exact stay, room, price, deposit and cancellation terms.
- Deposit calculations use integer minor currency units; no floating-point currency arithmetic.
- A payment is accepted only after server-side signature verification and exact amount/currency matching.
- A reservation is confirmed only after the connected hotel provider confirms it.
- All records and provider credentials are tenant-scoped; credentials remain encrypted server-side.
- Use idempotency keys for every operation that could create a hold, charge or reservation.
- If a provider cannot support a safe stage, fail closed and hand off to hotel staff rather than pretending to book.

## Current implementation status

The PMS adapter framework and sandbox exist, but no production PMS vendor adapter, payment gateway adapter, hotel credentials, live inventory, or authorized hotel test account are connected. The sandbox does not hold rooms, charge deposits or create real reservations.

`booking-workflow.js` currently provides tested domain primitives for guest-detail validation, 50% deposit arithmetic, explicit guest confirmation, verified payment transition and provider-confirmed reservation transition. These primitives are not yet wired to API routes, a database-backed booking state machine, a PMS vendor or a payment provider. Do not market the flow as live until those integrations and end-to-end tests are complete.
