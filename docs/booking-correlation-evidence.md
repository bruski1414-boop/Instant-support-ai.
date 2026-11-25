# Booking enquiry-to-reservation correlation foundation

## Status

This is a data-model and synthetic-test foundation only. No production booking provider is configured through this work, and no live reservation or guest data was used.

## How a future provider integration must work

1. A trusted Veyra server route issues a cryptographically random 256-bit, one-time correlation token for a conversation in the authenticated hotel's workspace.
2. Only the SHA-256 token hash is persisted. The plaintext token is returned once and must be passed through a booking-engine integration that explicitly supports opaque referral metadata.
3. A configured provider adapter verifies a signed webhook or performs an authenticated API readback. The adapter supplies a verifier function to createVerifiedReservationEvidence; callers cannot match a plain JSON object or set a verified flag themselves.
4. The normalized provider evidence must describe a confirmed reservation and echo the exact token. Pending, cancelled, modified-without-confirmation, expired-window and mismatched-token events do not create a match.
5. The store locks the intent, inserts one match, consumes the token and appends an audit event in one PostgreSQL transaction.
6. A provider reservation can be linked only once per hotel/provider. Exact event replays are idempotent; a different conversation cannot claim the same reservation.
7. Provider guest names, email addresses, phone numbers, notes and raw webhook bodies are not copied into the correlation tables.

## Reporting semantics

- A successful match means a provider-verified confirmed reservation carried a one-time token issued for a Veyra conversation.
- This is a linked confirmed booking, not proof that Veyra caused the booking or generated incremental revenue.
- Optional booking value is stored only when the provider verifier validates a positive integer minor-unit amount and supported ISO currency.
- Booking value is not paid revenue. It must not be added to paid add-on/settled revenue totals without separate payment evidence and reconciliation.
- A conversation deletion nulls the conversation link while retaining the provider reservation evidence and amount, so retention does not erase a financial record or leave a false Veyra attribution.

## Current blockers

- The main branch does not yet have a production booking provider adapter with a documented field/API that can safely carry the opaque token from enquiry to reservation.
- The Mews Connector General Webhook currently queues service-order identifiers; its public reservation contract does not document a private metadata field for this token. Do not put it in guest-visible notes, origin/channel fields or a URL.
- The new store is not wired to a public or authenticated HTTP route. It must only be called after a tenant-specific provider adapter has verified the webhook signature or authenticated API readback and resolved the provider connection to exactly one hotel.
- A real provider's reservation status and price semantics must be documented before mapping provider fields.
- Cancellation, no-show, partial refund and payment settlement events require separate adjustment/reconciliation logic before any booking value is reported as net revenue.

All fixtures and integration events are synthetic and labelled as such.


## Owner/admin booking attribution report

The read-only endpoint `GET /api/admin/booking-attribution/report` is restricted to authenticated workspace owners and administrators. It returns a rolling 720-hour UTC window with an inclusive start and exclusive end, computed by the server.

- `linkedConfirmedBookings` counts provider-confirmed reservation matches that still have a conversation link.
- `distinctLinkedConversations` counts distinct Veyra conversations among those matches. It is not a conversion rate or an influenced-conversation count.
- `retainedUnlinkedReservationRecords` counts provider reservation evidence whose conversation link was removed by conversation retention/deletion. These records are excluded from linked counts and booking-value totals.
- `providerReportedBookingValueByCurrency` groups the provider-supplied booking value at the matched event by currency using exact integer minor units. It is booking value, not settled payment, net revenue, profit or incremental revenue.
- Influenced conversations remain `not_measured`; estimated staff time saved remains `not_calculated`.

The dashboard section is visible only to owners and administrators. Staff roles do not call the financial booking-value report endpoint. The report contains aggregate counts and currency totals only; it does not return guest or conversation identifiers.

This report does not reconcile later reservation cancellations, no-shows, payment settlement, refunds or chargebacks, and therefore does not claim current reservation status or realised revenue. The report route is read-only; it does not issue correlation tokens, accept provider webhooks or connect to a booking provider. Until a trusted provider adapter and token-carrying booking flow are approved and implemented, synthetic integration tests are the only exercised source of matches.
