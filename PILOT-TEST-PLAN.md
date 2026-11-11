# Veyra AI — supervised hotel pilot test plan

This checklist is a release gate, not a claim that the checks have passed. Use synthetic data only until the hotel has approved privacy, retention, data-processing and hosting arrangements.

## 1. Test environment

- [ ] Use two separate test hotel workspaces, Hotel Alpha and Hotel Beta.
- [ ] Create separate owner, admin and staff accounts for each workspace.
- [ ] Use synthetic guest messages and fictional hotel policies only.
- [ ] Configure a test AI provider key and a test staff-notification receiver.
- [ ] Keep guest-data storage disabled in any environment used for public demonstrations.
- [ ] Record the deployed commit SHA and database migration state for each test run.

## 2. Tenant-isolation tests — must all pass

- [ ] Alpha owner cannot list, read, edit or delete Beta knowledge documents.
- [ ] Alpha staff cannot view Beta conversations, transcripts, escalations, members, audit events or settings.
- [ ] Alpha cannot use a Beta conversation ID and guest token to retrieve or continue a conversation.
- [ ] Alpha cannot import a file from Beta's connected Google or Microsoft account.
- [ ] Alpha cannot list, refresh, disconnect or replace Beta's OAuth connection.
- [ ] Changing a URL ID, slug, request body organization ID or query parameter never changes the authenticated workspace scope.
- [ ] Deactivated users lose access immediately, including existing sessions and pending OAuth callbacks.
- [ ] Suspended workspaces cannot start new guest sessions or storage operations.
- [ ] Every test is repeated with owner, admin, staff and viewer roles where applicable.

Any cross-workspace data exposure is a release-blocking security defect.

## 3. Knowledge and answer-quality tests

- [ ] Unapproved knowledge is never used in guest answers.
- [ ] Editing a previously approved document revokes approval until a hotel manager reviews it again.
- [ ] Overdue knowledge is excluded from answer context.
- [ ] The assistant answers only facts supported by the active hotel's approved documents.
- [ ] Missing, conflicting or ambiguous information produces a clear uncertainty response and staff handoff.
- [ ] Prompt-injection attempts in guest messages and imported documents do not override system rules or expose another hotel's data.
- [ ] The assistant never claims to have changed a booking, issued a refund, confirmed availability or completed another action without a verified integration result.
- [ ] Allergy, safety, medical, urgent, complaint, refund and booking-change messages are handed to staff according to the hotel's approved procedure.

## 4. Staff handoff and operations

- [ ] A test escalation reaches the configured staff receiver.
- [ ] Invalid receiver credentials and timeouts are recorded as failures, not reported as successful delivery.
- [ ] Retry limits are enforced and duplicate alerts are controlled.
- [ ] Staff can see the right conversation and mark the handoff claimed or resolved.
- [ ] The hotel has a documented manual fallback if the notification service is unavailable.
- [ ] Staff understand that a webhook HTTP success means accepted by the receiver, not read by a human.

## 5. Storage connector tests

- [ ] Google and Microsoft OAuth callbacks use the exact registered HTTPS redirect URI.
- [ ] OAuth state is single-use, expires, and is bound to the initiating active workspace administrator.
- [ ] PKCE verification is enforced by the provider.
- [ ] Tokens are encrypted at rest and never returned to the browser.
- [ ] Expired, revoked and invalid tokens fail safely and require reconnection.
- [ ] A hotel can browse and import only files its own authorised account can access.
- [ ] Oversized, empty, unsupported and malformed files are rejected safely.
- [ ] Imported documents are unapproved until a hotel manager verifies their contents.
- [ ] Disconnecting a provider removes that workspace's stored credentials.

## 6. Privacy, reliability and release gates

- [ ] Hotel approves its privacy notice, data-processing terms, lawful basis/consent where applicable, retention schedule and deletion process.
- [ ] Durable database hosting, automated backups and a successful restore drill are in place.
- [ ] Deletion behavior is documented for active records, logs, backups and provider retention.
- [ ] Secrets are stored only in the hosting provider's secret manager and rotated under an approved procedure.
- [ ] Rate limits, request-size limits, error handling and abuse controls are tested.
- [ ] Monitoring and an incident-response contact are documented.
- [ ] A hotel manager approves the knowledge base and staff escalation workflow.
- [ ] A supervised pilot is run with synthetic or explicitly approved limited data before broader guest use.
- [ ] Results are measured against a pre-pilot baseline; do not promise revenue or staffing outcomes without evidence.

## Automated CI baseline

The main-branch Veyra CI workflow runs Node.js 20 tests against a disposable PostgreSQL 16 service. The current automated suite includes syntax checks, unit/source regression tests and a live two-hotel API integration test using synthetic Hotel Alpha and Hotel Beta workspaces. That integration test covers separate owner sign-ins; tenant-scoped knowledge, settings, users, audit events, escalations, storage connections and overview data; hotel-specific CORS; signed staff-dispatcher test events and retry routing; parallel dashboard requests; and negative cross-tenant reads, edits and deletes.

A passing CI run proves only that those automated synthetic checks passed for the tested commit. It does not prove that the live Render environment has the required secrets, that a real hotel's OAuth or staff receiver works, that the live AI answers correctly, or that backups can be restored.

## Current known limitations

- The deployed web service and PostgreSQL database are on free plans; the database is temporary and scheduled to expire on 11 December 2026. Do not use it for real hotel or guest data.
- Guest-data storage is disabled by default. Keep it disabled until written hotel privacy/retention approval and durable backup/restore evidence exist.
- Storage import is limited to small text-based documents and Google Docs; full PDF, Word and spreadsheet extraction, broad sync and incremental sync are not complete.
- Google/Microsoft app registration, client credentials, consent and live OAuth flows still require authorised setup and testing with separate hotel accounts.
- The signed staff webhook path is covered with a synthetic test receiver in CI; the actual hotel dispatcher, staff ownership, delivery monitoring and manual fallback still need a supervised live test.
- Live AI model verification and answer-quality evaluation, browser-level end-to-end tests, sustained load tests, production monitoring, incident response and independent security/privacy review remain outstanding.
- The main-branch application uses explicit tenant-scoped SQL queries. Automated cross-tenant tests are important evidence, but they are not a substitute for independent review or a database-level security certification.
- The Render database is not reachable through the connected read-only database tool because its external IP allowlist is empty. Do not weaken the database allowlist to make an inspection tool work; use the authorised Render dashboard or a trusted operator environment when database inspection is required.

Do not describe Veyra as production-ready or hotel-ready until every applicable release gate has been tested and signed off.
