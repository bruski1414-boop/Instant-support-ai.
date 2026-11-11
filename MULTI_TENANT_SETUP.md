# Veyra AI deployment and pilot checklist

## Current deployment status

- Render web service: live at https://veyra-ai-prototype.onrender.com
- Render PostgreSQL: available and connected to the service.
- Latest deployment: live on 11 November 2026.
- Latest Veyra CI run: successful on 11 November 2026.
- Hosting plan: free web service and free PostgreSQL.
- Database expiry: 11 December 2026. This is temporary infrastructure; do not store real hotel or guest data here.

A parent or guardian must manage hosting accounts, any paid upgrades and API-provider billing.

## Implemented

- PostgreSQL tenant schema for organisations, users, sessions, approved knowledge, conversations, messages, escalations and audit logs.
- Tenant-scoped admin APIs for overview metrics, knowledge and escalation status.
- Password hashing using scrypt, random opaque session tokens stored as SHA-256 hashes, HttpOnly/SameSite cookies, CSRF checks and session expiry.
- First-owner bootstrap endpoint and setup page.
- Dashboard UI for sign-in, overview, conversations, knowledge approval and staff handoff status.
- Hotel-specific public AI endpoint at POST /api/public/:slug/chat. It uses only that hotel's approved knowledge and refuses to invent business facts.
- Conservative escalation for sensitive/uncertain requests.
- Optional signed webhook; delivery status and attempt count are persisted on each escalation, and failed notifications can be retried from the dashboard (maximum five attempts).
- Separate rate limits protect public guest chat and initial workspace bootstrap.
- Embeddable guest chat widget with multi-turn conversation continuity, bounded history and a per-conversation access token stored only as a hash server-side.
- Public file allowlist and baseline browser security headers.
- Tenant-scoped owner/admin conversation deletion from active database records (backup/provider retention may differ) with an audit record.
- Guest-data storage gate is disabled unless explicitly enabled after hotel privacy and retention approval.
- Per-hotel onboarding checks verify the hotel profile, approved/current knowledge, AI provider check, website origin, signed staff dispatcher check, OAuth-backed storage connection and privacy/storage state.
- Each hotel can authorize its own Google Drive or Microsoft account. OAuth tokens are encrypted at rest with AES-256-GCM; imports are limited to small plain-text files and Google Docs and always require manager approval.
- The operator-only hotel provisioning endpoint is protected by PLATFORM_PROVISIONING_TOKEN; the Node CLI provisions a separate workspace and first owner without exposing the token in browser code.
- CI includes a PostgreSQL-backed two-hotel integration test for tenant-scoped API data, website-origin CORS, signed handoff routing, concurrent dashboard reads and cross-tenant denial checks.

## Render environment variables

The Render service has a connected PostgreSQL database. Confirm the following values in the Render service environment; never paste secret values into source control or chat.

- DATABASE_URL: internal connection string from the Render Postgres instance.
- DATABASE_SSL=true
- OPENAI_API_KEY: provider secret, server-side only.
- OPENAI_MODEL=gpt-4.1-mini
- BOOTSTRAP_TOKEN: long random one-time setup secret; remove after owner setup.
- ALLOWED_ORIGINS: exact trusted platform/dashboard origins, comma-separated. Public guest-chat CORS is checked separately against the requested hotel's saved HTTPS website origin; a globally allowed origin cannot call another hotel's guest-chat route.
- NODE_ENV=production
- GUEST_DATA_STORAGE_ENABLED=false until platform privacy review, separate written approval for each hotel, durable backups and verified automated retention/deletion are in place.
- STAFF_WEBHOOK_URL and STAFF_WEBHOOK_SECRET: optional signed staff-notification receiver.
- PLATFORM_PROVISIONING_TOKEN: separate high-entropy operator-only secret used by the hotel provisioning endpoint. Never put it in browser code or public documentation.
- STORAGE_OAUTH_REDIRECT_BASE and STORAGE_TOKEN_ENCRYPTION_KEY: public callback origin and base64-encoded 32-byte encryption key for per-hotel OAuth tokens.
- GOOGLE_OAUTH_CLIENT_ID/SECRET and MICROSOFT_OAUTH_CLIENT_ID/SECRET: provider application credentials; register the exact callback URL shown in the README and complete provider consent.
- RETENTION_WORKER_ENABLED=true: starts the hourly purge worker for approved hotel workspaces. It removes expired conversations, messages and linked escalations, skips open/claimed escalations, and continues after an approval is revoked or guest intake is disabled. This is destructive; an authorised adult operator must enable it only after reviewing the policy.
- DURABLE_BACKUPS_VERIFIED, TENANT_ISOLATION_TESTS_PASSED, PROVIDER_OAUTH_TESTED, PLATFORM_PRIVACY_REVIEWED, RETENTION_ENFORCEMENT_VERIFIED, STAFF_HANDOFF_TESTED and PILOT_RELEASE_APPROVED: platform evidence flags. Set them only after the corresponding test/approval is genuinely complete; never set them to make readiness appear green. RETENTION_ENFORCEMENT_VERIFIED must remain false until live worker monitoring and backup-retention/deletion behavior are tested.

Without OPENAI_API_KEY, live AI responses are unavailable. Without both webhook settings, escalations are recorded but staff are not notified automatically.

## First owner setup

1. Confirm /api/health reports database=connected.
2. Use /setup.html with the one-time bootstrap token to create the first owner.
3. Remove BOOTSTRAP_TOKEN from the Render service environment and redeploy.
4. Sign in at /dashboard.html.
5. Add hotel knowledge as unapproved and have the hotel manager verify every fact before approval.
6. Set ALLOWED_ORIGINS to the exact platform/dashboard origin(s), then save each hotel's exact HTTPS website origin in that hotel's own workspace settings. Public guest chat only allows the matching hotel's saved origin.
7. Verify the hotel's staff notification endpoint and test its fallback process.
8. Do not enable guest-data storage until privacy notice, data-processing terms and retention period are approved and durable storage/backups are ready.

## Widget embed

```html
<script src="https://veyra-ai-prototype.onrender.com/widget.js"
        data-veyra-slug="your-hotel-slug"
        data-veyra-api="https://veyra-ai-prototype.onrender.com"
        async></script>
```

## API

- GET /api/health — process health and configuration snapshot; it can return HTTP 200 while pilot readiness is degraded.
- GET /api/readiness — platform-wide release gate; returns 503 until all required evidence flags and configuration checks pass.
- POST /api/setup/organization
- POST /api/platform/organizations — operator-only additional hotel provisioning; requires PLATFORM_PROVISIONING_TOKEN.
- POST /api/platform/organizations/:slug/privacy-approval — platform-operator-only record of that hotel's written privacy approval and retention target; requires the same operator token. DELETE on the same path revokes the record.
- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/me
- GET /api/auth/csrf
- GET /api/admin/conversations/:id — tenant-scoped conversation transcript\n- DELETE /api/admin/conversations/:id — owner/admin-only, tenant-scoped conversation deletion\n- GET /api/admin/onboarding — hotel-specific setup and readiness checks.
- POST /api/admin/integrations/test-ai and POST /api/admin/integrations/test-staff-webhook — per-hotel live integration verification.
- GET /api/admin/storage/connections and POST /api/admin/storage/connect/:provider — hotel-specific OAuth connection setup.
- GET /api/admin/storage/files/:provider and POST /api/admin/storage/import/:provider — browse/import supported files for manager review.
- DELETE /api/admin/storage/connections/:provider — disconnect that hotel's provider account.
- GET /api/admin/overview
- GET/POST /api/admin/knowledge
- PATCH/DELETE /api/admin/knowledge/:id
- GET /api/admin/escalations
- POST /api/admin/escalations/:id/notify — retry a failed notification (maximum five attempts)
- PATCH /api/admin/escalations/:id
- POST /api/public/:slug/chat

## Remaining before a real hotel pilot

- Replace temporary free database hosting with a durable plan; configure automated backups and prove restoration. The current free database expires on 11 December 2026.
- Obtain hotel-approved privacy notice, data-processing terms, lawful basis/consent where required, retention and deletion workflow before any real guest data is stored.
- Record each hotel's written privacy approval separately through the operator-only approval endpoint. A global platform privacy review or one hotel's approval must never unlock another hotel's workspace.
- The per-hotel hourly retention worker is implemented and covered by synthetic CI tests. Verify its live monitoring, failure handling and backup-retention/deletion behavior before RETENTION_ENFORCEMENT_VERIFIED or PILOT_RELEASE_APPROVED can be set.
- Test the actual hotel's signed webhook, retries, delivery audit, staff ownership and manual fallback. CI uses only a synthetic test receiver.
- Complete live AI provider/model verification and separate Google/Microsoft OAuth tests using authorised hotel test accounts.
- Add email verification, password recovery, MFA, invitation email delivery and subscription billing. Staff invitations exist, but delivery is manual.
- Complete independent security/privacy review, browser-level end-to-end tests, full role/permission matrix, live-model prompt-injection/answer-quality evaluation, sustained load tests and production abuse monitoring.
- The main-branch app uses explicit tenant-scoped SQL queries; passing CI is not a substitute for independent security review or database-level tenant-enforcement assurance.
- Add production monitoring, alerting, incident response, hotel manager sign-off and supervised pilot with baseline measurement.

Do not use real guest data or present this as production-ready until the hotel and responsible adults have approved the operational, legal, privacy and security requirements.


Knowledge history: the platform stores document snapshots and change types. The history endpoint checks both document ID and workspace ID; document deletion removes its snapshots. Any edit to title, category or content automatically resets approval.
