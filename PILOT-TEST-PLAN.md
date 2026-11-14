# Veyra AI — supervised hotel pilot release test plan

**Release status: BLOCKED pending evidence and authorised hotel sign-off.** This is a checklist, not a statement that every item has passed. Use synthetic data until the hotel has approved privacy, retention, data-processing and hosting arrangements.

## 1. Test environment and release identity

- [ ] Use a dedicated production-grade test deployment and durable database; do not use the temporary free prototype database for guest data.
- [ ] Use two separate synthetic hotel workspaces, Hotel Alpha and Hotel Beta.
- [ ] Create owner, admin, staff and viewer test accounts for each workspace.
- [ ] Use synthetic guest messages, fictional hotel policies, test AI credentials and a hotel-controlled test notification receiver.
- [ ] Keep guest-data storage disabled in public demonstrations.
- [ ] Record the exact commit SHA, deployed SHA, CI workflow links, database migration state and environment configuration evidence.
- [ ] Confirm the deployed service is not the synthetic `/demo` route and clearly distinguishes test from live hotel operation.

## 2. Tenant isolation — release blocking

The repository now contains a PostgreSQL-backed two-hotel integration suite and tenant-scoped API tests. Passing CI is evidence for the scenarios covered by those tests; it is not proof that every route, role or data path has been independently audited.

- [ ] Alpha cannot list, read, edit or delete Beta knowledge documents or document versions.
- [ ] Alpha cannot view Beta conversations, transcripts, messages, escalations, revenue records, members, invitations, audit events, integration settings or privacy approvals.
- [ ] Alpha cannot use Beta conversation IDs and guest tokens to retrieve or continue conversations.
- [ ] Alpha cannot import, list, refresh, disconnect or replace Beta's Google/Microsoft storage connection.
- [ ] Alpha cannot access or replace Beta's Mews credentials or configuration.
- [ ] Changing URL IDs, slugs, request-body organization IDs or query parameters never changes authenticated workspace scope.
- [ ] Deactivated users lose access immediately, including existing sessions and pending OAuth callbacks.
- [ ] Suspended workspaces cannot start guest sessions or storage operations.
- [ ] Repeat all applicable authorization tests for owner, admin, staff and viewer roles.
- [ ] Have an independent reviewer inspect all tenant-scoped queries and new routes before real guest data is enabled.

Any cross-workspace exposure is a release-blocking defect.

## 3. Knowledge and answer quality

- [ ] Unapproved knowledge is never used in guest answers.
- [ ] Editing an approved document revokes approval until a hotel manager reviews it again.
- [ ] Overdue knowledge is excluded from answer context.
- [ ] Answers use only the active hotel's approved and current sources.
- [ ] Missing, conflicting or ambiguous information produces a clear uncertainty response and staff handoff.
- [ ] Prompt-injection attempts in guest messages and imported documents do not override system rules or expose hidden instructions or another hotel's data.
- [ ] Unsupported prices, dates, hours, phone numbers, URLs, policies and numeric claims are not invented.
- [ ] The assistant never claims to have changed a booking, issued a refund, confirmed availability or completed a payment.
- [ ] Allergy, safety, medical, urgent, complaint, refund and booking-change messages follow the hotel's approved escalation procedure.
- [ ] Run at least 30 hotel-approved scenarios, including paraphrases, misspellings, multilingual questions if in scope, long inputs, empty inputs and repeated turns.
- [ ] Have hotel staff review answer transcripts and source evidence; automated grounding tests alone are not sufficient.

## 4. Staff handoff and operations

- [ ] A signed test escalation reaches the correct hotel-controlled receiver.
- [ ] Wrong secrets, invalid receiver responses, timeouts and network failures are recorded as failures, not successes.
- [ ] Retry limits, duplicate alerts and repeat guest messages are tested.
- [ ] Staff can see the correct conversation, claim it, reply and resolve the escalation.
- [ ] The hotel names a primary and backup escalation owner and agrees response expectations.
- [ ] A documented manual fallback works if the dispatcher or Veyra is unavailable.
- [ ] Staff understand that webhook HTTP success means accepted by the receiver, not read or acted upon by a human.

## 5. Storage and PMS connectors

- [ ] Google and Microsoft OAuth callbacks use the exact registered HTTPS redirect URI.
- [ ] OAuth state is single-use, expires and is bound to the initiating active workspace administrator.
- [ ] Provider consent, scopes, PKCE and token refresh/revocation behavior are tested against the actual provider app.
- [ ] Tokens are encrypted at rest and never returned to the browser.
- [ ] A hotel can access only files its own authorised account can access.
- [ ] Oversized, empty, unsupported and malformed files are rejected safely.
- [ ] Imported documents remain unapproved until a hotel manager verifies their contents.
- [ ] Disconnecting a provider removes that workspace's stored credentials.
- [ ] Do not treat Mews demo-host tests as production PMS certification. Production Mews access requires the relevant partner onboarding, credentials, hotel authorisation and end-to-end verification.
- [ ] Do not enable booking writes, cancellations, payments or inventory promises in this pilot.

## 6. Privacy, security and reliability

- [ ] An authorised hotel operator approves the privacy notice, data-processing terms, lawful basis/consent where applicable, subprocessors, retention schedule and deletion process.
- [ ] Each hotel records its current workspace privacy approval; the platform-wide readiness flag is supported by documented evidence.
- [ ] Durable database hosting and automated backups are configured, and a restore drill succeeds.
- [ ] Deletion behavior is documented for active records, audit logs, provider copies and backup retention.
- [ ] Secrets are stored only in the hosting secret manager and rotated under an approved procedure.
- [ ] Request size, rate limits, abuse controls, session security, CORS, CSRF and security headers are tested.
- [ ] Confirm rate-limit behavior across multiple app instances; do not assume in-memory limits are distributed.
- [ ] Monitoring, uptime checks, incident response owner and breach/escalation procedure are documented.
- [ ] Conduct independent security review and remediate all high/critical findings.
- [ ] Test restart behavior, database outage, AI provider outage, notification outage and sustained expected traffic.
- [ ] Confirm a safe shutdown/disable path and human contact route.

## 7. Formal pilot approval

- [ ] The exact release commit passes `npm test` and `npm run test:integration`.
- [ ] All ten `GET /api/readiness` release checks have supporting evidence; do not set environment flags simply to make the endpoint green.
- [ ] The hotel's authorised operator approves the knowledge base, website widget, data processing and escalation workflow in writing.
- [ ] The responsible adult platform operator approves hosting, provider accounts, secrets, billing and incident response.
- [ ] A supervised pilot is approved with synthetic or explicitly approved limited data.
- [ ] Baseline and success criteria are agreed before launch.
- [ ] A post-pilot review is scheduled; expansion is blocked until results and incidents are reviewed.

## Current implementation facts and limitations

- Implemented foundation includes tenant-scoped accounts/roles, knowledge approval/version history, guest chat, conversation evidence, staff escalation records, signed webhook delivery/retries, retention cleanup controls, tenant-specific privacy acknowledgements, encrypted Mews demo credentials, and a synthetic public demo.
- The current feature branch's latest recorded CI commit passed Node CI including PostgreSQL integration and Veyra CI. Check the exact branch head and workflows again before any release.
- The public demo uses fictional data, deterministic scripted replies and a simulated on-screen queue. It is not a real hotel deployment.
- The Mews connector is restricted to the official demo environment; production PMS access is not verified.
- Real Google/Microsoft OAuth app registration, hotel tenant consent and provider flows are not verified merely by unit tests.
- The current Render prototype uses free hosting; the database is temporary and scheduled to expire on 11 December 2026. Do not put real guest data there.
- Guest-data storage is disabled by default. Retention cleanup is manual; it is not an automatic scheduled purge.
- Production backups/restore, monitoring, incident response, independent security review, sustained load testing, email verification, password recovery, MFA and subscription billing remain outstanding.
- The current test suite is meaningful but does not replace a hotel operator's acceptance testing or independent security review.

Do not describe Veyra as production-ready or hotel-ready until all applicable gates have passed with evidence and the authorised hotel operator has signed off.
