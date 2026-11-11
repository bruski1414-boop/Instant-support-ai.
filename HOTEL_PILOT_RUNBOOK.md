# Veyra AI — first hotel pilot runbook

## What this pilot is
A controlled evaluation of a website customer-support assistant for one hotel. It is not yet a multi-tenant enterprise SaaS platform, a property-management-system integration, or an automated booking/refund agent.

## Non-negotiable launch gates
- A parent or guardian helps manage hosting, provider accounts, contracts, and billing because the founder is under 18.
- The hotel gives written permission to use its name, approved FAQs, website widget, and any test data.
- A hotel manager approves every answer source: breakfast times, check-in/out, facilities, parking, transport, accessibility, and contact routes.
- Do not ingest guest names, passport details, payment data, rooming lists, medical details, or private booking records for this pilot.
- Never claim a reservation, cancellation, refund, payment, or staff notification has been completed.
- Keep a named hotel staff member responsible for escalations. The current backend only sets an escalation flag; it does not notify staff.
- The hotel can disable the widget immediately and has a human contact route available at all times.

## Before the first guest-facing test
1. Create a separate demo environment for the hotel; do not reuse another hotel's content.
2. Replace the demo business name and FAQ with hotel-approved, dated information.
3. Set OPENAI_API_KEY as a server secret in Render. Never commit it.
4. Set ALLOWED_ORIGINS to the exact hotel website origins, not a wildcard.
5. Confirm the health endpoint reports ai-configured; confirm the model and provider usage limits with the account owner.
6. Run the automated tests with npm test.
7. Test at least 30 hotel-approved questions, including unknown questions, outdated information, complaints, refund requests, allergies, safety issues, and attempts to override the assistant instructions.
8. Verify uncertain and sensitive cases are routed to a visible human contact route. Until a real notification integration is implemented, staff must monitor the agreed channel manually.
9. Get hotel approval before placing the widget on a public website.

## Pilot measurement (baseline first)
For 2–4 weeks, record aggregate counts only:
- conversations started
- questions answered from approved information
- conversations escalated
- unanswered questions
- staff time spent reviewing escalations
- guest feedback or complaint rate, if the hotel already measures it

Compare with a pre-pilot baseline. Do not claim extra revenue or labour savings unless the hotel can verify them. Agree success criteria with the hotel before the pilot begins.

## What must be built before selling this as a scalable subscription
- Authentication, role-based access, and strict tenant isolation
- Persistent database with per-hotel knowledge and audit history
- Real staff notifications, retries, delivery status, and escalation ownership
- Admin interface for hotel-approved knowledge updates
- Privacy notice, data retention/deletion controls, consent and processor terms
- Rate limits and abuse controls per tenant, not just per IP
- Automated tests for prompt injection, hallucinations, privacy boundaries, and failure modes
- Monitoring, backups, incident response, uptime checks, and restore testing
- Secure billing and subscription lifecycle
- Independent security review and hotel sign-off

## Commercial rule
Start with one design-partner hotel and a time-limited pilot. Agree scope and success measures in writing. Do not promise a particular revenue increase, guaranteed uptime, staff replacement, or enterprise readiness before evidence supports it.
