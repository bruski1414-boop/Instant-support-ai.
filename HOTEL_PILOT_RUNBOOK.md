# Veyra AI — first hotel pilot runbook

## What this pilot is
A controlled evaluation of Veyra's multi-tenant hotel-support prototype. Each hotel has a separate workspace, owner/staff accounts, approved knowledge, conversations and OAuth storage connection. Automated tests exercise two synthetic hotels, but this is not an enterprise-certified SaaS platform, a property-management-system integration, or an automated booking/refund agent.

## Non-negotiable launch gates
- A parent/guardian or authorised adult manages hosting, provider accounts, contracts and billing.
- The hotel gives written permission to use its name, approved FAQs, website widget, and any test data.
- A hotel manager approves every answer source: breakfast times, check-in/out, facilities, parking, transport, accessibility, and contact routes.
- Do not ingest guest names, passport details, payment data, rooming lists, medical details, or private booking records for this pilot.
- Never claim a reservation, cancellation, refund, payment, or staff notification has been completed.
- Keep a named hotel staff member responsible for escalations. Veyra supports a signed central staff dispatcher, per-hotel verification, persisted delivery status and a bounded retry action. A successful HTTP response means the receiver accepted the event, not that a human read it. Verify the actual hotel's routing and manual fallback before guest traffic.
- The hotel can disable the widget immediately and has a human contact route available at all times.

## Before the first guest-facing test
1. Create a separate demo environment for the hotel; do not reuse another hotel's content.
2. Replace the demo business name and FAQ with hotel-approved, dated information.
3. Set OPENAI_API_KEY as a server secret in Render. Never commit it.
4. Set ALLOWED_ORIGINS to the exact hotel website origins, not a wildcard.
5. Check /api/health for process/database/AI state and /api/readiness for the platform release gate. /api/health can be healthy while the pilot is not ready; /api/readiness must return 200 before guest traffic. Confirm the model and provider usage limits with the account owner.
6. Run the automated tests with npm test.
7. Test at least 30 hotel-approved questions, including unknown questions, outdated information, complaints, refund requests, allergies, safety issues, and attempts to override the assistant instructions.
8. Run the per-hotel signed staff-dispatcher test and verify the actual hotel team receives the right organization ID/slug. Confirm a named person owns the queue and test the manual fallback; do not treat webhook acceptance as proof that staff read the alert.
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

## Implemented baseline (still requires live verification)

- Multi-tenant PostgreSQL schema and organization-scoped API queries for workspaces, users, knowledge, conversations, messages, escalations and audit records.
- Workspace sign-in, owner/admin/staff/viewer roles, hashed passwords and sessions, CSRF checks, staff invitations, deactivation and session revocation.
- Hotel dashboard for knowledge approval, conversation review, escalation queue, team access and security activity.
- Per-hotel knowledge source references, review dates and version history; overdue or unapproved material is excluded from guest-answer context.
- Per-hotel Google Drive and Microsoft OAuth connections with encrypted tokens. The current importer supports small plain-text files and Google Docs; imports require manager approval.
- Signed staff-dispatcher events include stable organization ID and slug. Delivery state and retry counts are stored per escalation.
- Hotel-specific website-origin CORS, public-chat rate limits, bounded message/history sizes and guest conversation tokens stored as hashes.
- CI includes syntax/unit checks and a PostgreSQL-backed two-hotel API integration test covering tenant separation, CORS, signed handoff routing and concurrent dashboard reads. These tests use synthetic data and a test receiver.

## What remains before a real guest pilot or scalable subscription

- Durable database hosting, automated backups and a documented successful restore drill. The current free PostgreSQL instance is temporary and expires on 11 December 2026.
- Written hotel approval for the website widget, knowledge sources, privacy notice, data-processing terms, retention/deletion process and any permitted guest data.
- Platform-wide privacy review and per-hotel approval are separate gates. The operator-only privacy approval record must refer to the hotel's written approval and retention target.
- The hourly per-hotel retention worker is implemented and covered by synthetic CI tests. It deletes expired conversations, messages and linked escalations, skips open/claimed escalations, and continues after approval revocation. Keep RETENTION_ENFORCEMENT_VERIFIED and PILOT_RELEASE_APPROVED false until live worker monitoring and backup-retention/deletion behavior are tested and independently reviewed.
- A platform operator records each hotel's written privacy/retention approval separately. Approval for one hotel must never unlock another hotel's workspace.
- Live AI provider/model verification, each hotel's own OAuth authorization, and the actual signed staff dispatcher tested with the hotel team and manual fallback.
- Independent security/privacy review. The current main-branch application relies on explicit tenant-scoped queries; CI coverage is valuable but is not a security certification.
- Live-model answer-quality and prompt-injection evaluation, browser-level end-to-end tests, sustained load testing and a full owner/admin/staff/viewer permission review.
- Production monitoring, alerting, incident response, support ownership and a tested rollback procedure.
- Distributed/per-tenant abuse controls; the current rate limits are application-level and are not a substitute for a production-wide abuse strategy.
- Email verification, password recovery, MFA, invitation email delivery and subscription billing are not complete. Invitation links are currently delivered manually.
- PMS/booking, payment/refund, CRM, email/SMS/WhatsApp and other hotel-system integrations are not included.

Keep guest-data storage disabled and public guest chat fail-closed until the platform-wide and hotel-specific release checks have evidence behind them. Never set readiness flags merely to make a dashboard green.

## Commercial rule
Start with one design-partner hotel and a time-limited pilot. Agree scope and success measures in writing. Do not promise a particular revenue increase, guaranteed uptime, staff replacement, or enterprise readiness before evidence supports it.
