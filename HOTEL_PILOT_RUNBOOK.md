# Veyra AI — supervised first-hotel pilot runbook

**Status: NOT APPROVED FOR REAL GUEST USE.** This runbook describes the path to a narrowly scoped, supervised pilot. A green CI run is necessary but is not a hotel launch approval.

## Pilot scope

Start with one design-partner hotel and a website FAQ assistant only. The first pilot must not make or modify reservations, take payments, issue refunds, change guest records, or promise room availability. The current Mews connector is restricted to the official Mews demo environment; production PMS access is not implemented or certified.

Use a separate production-grade environment for the hotel. Do not use the public synthetic demo as a hotel deployment. The demo's fictional Aster House data, metrics, simulated queue and scripted responses are not live hotel functionality.

## Non-negotiable ownership and approval

- Because the founder is under 18, a parent/guardian and the hotel's authorised adult operator must manage hosting accounts, provider accounts, credentials, contracts, billing and legal/privacy decisions.
- Obtain written permission from the hotel for the pilot, the hotel name/brand, website widget, approved knowledge and any permitted data processing.
- The hotel's authorised operator must approve the privacy notice, data-processing terms, lawful basis/consent where required, retention schedule, deletion process and vendor/subprocessor arrangements. The dashboard acknowledgement is a record of acknowledgement, not legal approval or certification.
- Name a hotel staff owner for escalations and a backup. Agree a manual contact route and a process for disabling the widget immediately.
- Begin with synthetic test messages. For the first guest-facing phase, avoid collecting guest names, booking references, passport/identity data, payment data, rooming lists, medical details or other sensitive information. Do not use private booking records as knowledge.
- Never claim a booking, cancellation, refund, payment, room availability or staff notification is complete unless a verified integration confirms the result. The Mews integration in this branch is demo-host-only and read-only.

## Technical release gates

All ten checks from `GET /api/readiness` must be true before the guest chat endpoint will operate:

1. `DATABASE_URL` connects successfully.
2. A server-side AI provider key is configured.
3. `GUEST_DATA_STORAGE_ENABLED=true` is enabled only after the hotel has approved the data-processing and retention arrangements.
4. A signed staff dispatcher URL and secret are configured.
5. `DURABLE_BACKUPS_VERIFIED=true` only after automated durable backups and a documented restore drill have been verified.
6. `TENANT_ISOLATION_TESTS_PASSED=true` only after the relevant two-hotel isolation suite passes on the release commit.
7. `PROVIDER_OAUTH_TESTED=true` only after the exact provider OAuth flows used by the hotel have been tested with the hotel's approved app configuration.
8. `HOTEL_PRIVACY_APPROVED=true` only after the authorised hotel operator signs off the actual privacy/data-processing arrangements. This is a global deployment gate; each workspace must also record its own current owner/admin approval in the dashboard.
9. `STAFF_HANDOFF_TESTED=true` only after an end-to-end signed test reaches the correct hotel receiver and the manual fallback is confirmed.
10. `PILOT_RELEASE_APPROVED=true` only after the authorised hotel operator and responsible adult platform operator approve the written pilot checklist.

Do not set these flags just to make the health endpoint green. They are attestations that require supporting evidence. `GET /api/readiness` returns 503 until every gate is true. The endpoint is not an independent audit or certification.

Additional per-hotel checks are enforced by guest chat: current privacy approval, AI and staff integration checks, a connected hotel-owned storage account with a successful sync, current approved knowledge, and enabled guest-data storage.

## Before any guest-facing test

1. Use a dedicated, durable production database and web service for the hotel. Do not use the free prototype database; it is temporary and scheduled to expire on 11 December 2026.
2. Configure secrets only in the hosting provider's secret manager. Never put API keys, webhook secrets, OAuth credentials or provisioning tokens in Git, browser code, screenshots or hotel-facing pages.
3. Restrict allowed origins to the exact hotel website origin and verify the widget cannot be embedded from an unrelated origin.
4. Have the hotel's authorised operator create the workspace and own its credentials. The founder should not handle guest or hotel secrets.
5. Have a hotel manager approve each knowledge source, its source reference and review date. Editing content must trigger reapproval.
6. Complete and retain evidence for every technical release gate above.
7. Run `npm test` and `npm run test:integration` on the exact release commit. Record commit SHA, workflow links, database migration state and test output.
8. Complete every relevant item in `PILOT-TEST-PLAN.md`, including at least 30 hotel-approved questions and prompt-injection, outdated-information, unsupported-claim, complaint, refund, allergy and safety scenarios.
9. Test the signed staff notification against a hotel-controlled test receiver. Confirm delivery status, retries, duplicate handling, staff ownership and manual fallback. HTTP acceptance does not prove a human read the alert.
10. Verify the hotel's widget can be disabled and that a visible human contact route remains available.
11. Obtain written go-live approval from the authorised hotel operator before installing the widget on a public website.

## Measure the pilot honestly

Capture a pre-pilot baseline and agree success criteria in writing. For a 2–4 week supervised pilot, collect aggregate operational measures only where possible:

- conversations started
- answers supported by current approved hotel knowledge
- escalations and notification failures
- unanswered or incorrectly answered questions
- first-response time and staff review time
- guest feedback and complaints, using the hotel's existing measurement process

Do not equate an AI-only conversation with a resolved guest issue. Do not claim revenue uplift, labour savings, conversion improvement or causation without independently verifiable hotel evidence. Keep hotel-reported revenue separate from Veyra-linked, hotel-attested records.

## Current known limitations

- The public demo is synthetic, deterministic and isolated. It does not use the AI provider, database, Mews, or real staff notifications.
- The Mews adapter is restricted to the official demo host. No production Mews credentials, partner approval, hotel connection or production inventory call has been verified.
- Google/Microsoft OAuth and storage connectors require real app registration, tenant consent and end-to-end provider testing before relying on them.
- Durable paid hosting, backup/restore evidence, production monitoring, incident response and a security review are not established by the current CI status.
- Email verification, password recovery, MFA, subscription billing and a complete commercial support process are not yet release-complete.
- Guest chat now has a per-hotel plus client-IP rate-limit key, in addition to the shared API limit. The default store is in-memory per process, not distributed; configure a shared store and validate proxy/IP settings before multi-instance scaling.
- Privacy approval records and readiness flags are gates, not legal advice, compliance certification or security certification.

## Commercial rule

Start with one design-partner hotel, a narrow written scope, a time-limited supervised pilot and agreed success measures. Do not sell Veyra as enterprise-ready, promise guaranteed uptime, staff replacement, booking automation or a specific financial return until those capabilities are implemented and evidenced.
