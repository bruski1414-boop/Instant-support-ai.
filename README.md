# Veyra AI

Veyra AI is a hotel customer-support platform prototype. It is designed to answer guest questions using hotel-approved information and route uncertain or sensitive requests to staff.

## Live project

- Public demo site: https://veyra-ai-prototype.onrender.com
- Owner dashboard: https://veyra-ai-prototype.onrender.com/dashboard.html
- First workspace setup: https://veyra-ai-prototype.onrender.com/setup.html
- Source code: https://github.com/bruski1414-boop/Instant-support-ai.

## Current deployment

The Render web service is connected to PostgreSQL. GitHub Actions CI runs on Node.js 20 with a temporary PostgreSQL 16 service and executes the complete test suite, including a live two-hotel API isolation test. A successful deployment or CI run is useful evidence, but neither certifies the product for real guest data or a hotel launch.

The web service and database are currently on Render's free plans. The database is temporary and is scheduled to expire on 11 December 2026. Do not put real hotel or guest data into this environment. A parent or guardian must manage hosting accounts, any paid upgrades and provider billing.

## Implemented foundation

- Express API and PostgreSQL multi-tenant schema.
- Organisation, user, session, approved-knowledge, conversation, message, escalation and audit-log tables.
- Tenant-scoped dashboard APIs for overview, knowledge and staff handoffs.
- Owner/admin/staff/viewer roles; scrypt password hashing; opaque session tokens; HttpOnly/SameSite cookies; CSRF checks; and session expiry.
- One-time first-owner bootstrap endpoint and setup page.
- Protected, rate-limited platform provisioning endpoint for creating additional hotel workspaces and their first owners. It requires a server-side `PLATFORM_PROVISIONING_TOKEN`; it is not an open public signup route. An operator-only Node CLI creates new hotel workspaces without exposing the provisioning secret in a browser.
- Tenant-scoped staff invitations: hashed single-use tokens, 24-hour expiry, revocation, role restrictions and a dedicated acceptance page. Invitation delivery is manual; no email provider is connected.
- Workspace member management: owner/admin can deactivate staff accounts; deactivation revokes all active sessions. Admins cannot change owner or administrator access.
- Tenant-scoped security activity viewer for workspace owners and admins.
- Hotel workspace profile and pre-pilot readiness checklist for website origin, approved knowledge, AI configuration, staff notification and privacy/storage gate. Each hotel's saved HTTPS website origin is dynamically allowed by CORS without adding every hotel to a global allowlist.
- Per-hotel AI model verification and signed staff-dispatcher test events. Successful checks are recorded against the specific hotel workspace and appear in its onboarding checklist. The shared staff dispatcher receives each hotel's organization ID and slug so it can route to the correct hotel team.
- Knowledge source references and review dates, with overdue documents automatically excluded from guest-answer context until reviewed.
- Owner dashboard for conversations, knowledge approval and escalation status.
- Embeddable guest chat widget with multi-turn conversation continuity, bounded history and a per-conversation access token stored only as a hash server-side.
- Public file allowlist so source files, tests and internal documentation are not served as website assets.
- Baseline browser security headers (content-type sniffing, framing, referrer and permissions policies).
- Tenant-scoped owner/admin conversation deletion from active database records (backup/provider retention may differ) with an audit record.
- Tenant-scoped, read-only Google Drive and Microsoft OneDrive/SharePoint OAuth connectors. OAuth tokens are encrypted at rest with AES-256-GCM; each workspace stores its own provider connection; OAuth state is single-use and expires after ten minutes.
- Hotel owners/admins can browse plain-text documents and Google Docs, choose individual files, and import them into that hotel's knowledge base. Imports are unapproved by default and must be manager-verified before guest use. SharePoint site discovery and site-root text-file browsing are included.
- AI answer generation constrained to each hotel's approved knowledge, with conservative escalation for uncertain or sensitive requests.
- Optional signed staff webhook with persisted delivery status, attempt count and a dashboard retry action for failed notifications.
- Separate rate limits for public guest chat and first-owner bootstrap.
- Guest conversation storage is disabled by default until privacy and retention arrangements are approved.
- GitHub Actions CI runs syntax checks and Node's test suite against PostgreSQL 16. The two-hotel integration test provisions separate workspaces, signs in as both owners, checks tenant separation across knowledge, settings, staff, audit events, storage connections, conversations and escalations, attempts cross-tenant reads/edits/deletes, verifies distinct website CORS origins, tests signed staff-dispatcher events for both hotels and sends concurrent dashboard requests. The AI connection test correctly reports unconfigured when no provider key is present. Live Google/Microsoft OAuth, real provider credentials, production notification routing, backup/restore and sustained load testing remain outstanding.

## Provisioning additional hotels

A trusted platform operator (not a hotel guest and not a hotel workspace user) can create a hotel workspace using the Node.js 20 CLI. The Render account owner must first add a high-entropy `PLATFORM_PROVISIONING_TOKEN` to the service's secret environment variables. Never put that token in dashboard JavaScript, a public page, a GitHub commit, or a hotel owner's browser.

Set these environment variables in a secure operator shell: `VEYRA_BASE_URL`, `PLATFORM_PROVISIONING_TOKEN`, `HOTEL_NAME`, `HOTEL_OWNER_EMAIL`, and `HOTEL_OWNER_PASSWORD`. Then run `npm run provision:hotel`. The script prints the new workspace slug and owner email, but never prints the password or token. Deliver credentials to the hotel owner through a secure channel and remove the temporary shell variables afterwards. A parent/guardian or authorized adult must manage hosting credentials and any paid account changes.

Each hotel owner then signs in to its own workspace, saves the hotel's HTTPS website origin and staff contact, authorizes that hotel's own Google Drive or Microsoft account, imports information for manager review, and runs the AI and staff-dispatcher tests. The AI test requires a valid server-side `OPENAI_API_KEY`; the staff test requires a signed central dispatcher that routes by organization ID/slug. Do not enable guest-data storage or mark pilot release gates complete until written hotel approval, durable backups, restore testing, privacy/retention terms and staff procedures are in place.

## Runtime configuration

The Render service currently starts with PostgreSQL connected. Live AI responses require a server-side `OPENAI_API_KEY`; staff notifications require a verified `STAFF_WEBHOOK_URL` and matching `STAFF_WEBHOOK_SECRET`.

Important environment variables:
- `DATABASE_URL`: Render Postgres internal connection string.
- `DATABASE_SSL`: defaults to TLS enabled.
- `OPENAI_API_KEY`: provider secret stored only in Render.
- `OPENAI_MODEL`: defaults to `gpt-4.1-mini`.
- `BOOTSTRAP_TOKEN`: one-time first-workspace setup secret; remove it after the first owner is created.
- `PLATFORM_PROVISIONING_TOKEN`: separate high-entropy server-side secret required to create each additional hotel workspace and record/revoke per-hotel privacy approvals through the protected platform API. Keep it only in hosting secrets and never put it in browser code or public documentation.
- `ALLOWED_ORIGINS`: exact platform/admin origins permitted to call the API. A hotel's own saved HTTPS origin is also dynamically allowed for its own embeddable guest widget.
- `GUEST_DATA_STORAGE_ENABLED`: defaults to false. Do not enable until platform privacy review, each hotel's separately recorded written approval, durable backups and verified automated retention/deletion are in place.
- `STORAGE_OAUTH_REDIRECT_BASE`: public HTTPS origin of this Veyra deployment, for example `https://veyra-ai-prototype.onrender.com`.
- `STORAGE_TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte random key used for AES-256-GCM encryption of per-hotel OAuth tokens. Keep only in hosting secrets; never commit it.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`: Google OAuth web application credentials. Register callback `https://<veyra-origin>/api/admin/storage/oauth/callback` and enable the Google Drive API.
- `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET`: Microsoft Entra application credentials. Register the same callback as a Web redirect URI and grant admin-approved delegated permissions `Files.Read.All`, `Sites.Read.All`, `User.Read`, and `offline_access`.
- `STAFF_WEBHOOK_URL` and `STAFF_WEBHOOK_SECRET`: signed central staff-dispatcher receiver. It must route using the event's `organizationId` and `organizationSlug`; each hotel owner can send a labelled integration test from their workspace.
- `DURABLE_BACKUPS_VERIFIED=true`: set only after a durable backup and restore test is documented.
- `TENANT_ISOLATION_TESTS_PASSED=true`: set only after automated tests prove cross-hotel data isolation.
- `PROVIDER_OAUTH_TESTED=true`: set only after Google/Microsoft OAuth and document access are tested with separate test tenants.
- `PLATFORM_PRIVACY_REVIEWED=true`: platform-wide privacy and data-processing review; it is not a substitute for each hotel's own written approval.
- `RETENTION_WORKER_ENABLED=true`: starts the hourly per-hotel purge worker. It deletes conversations, messages and linked escalations after the hotel's retention period, skips open/claimed escalations, and continues purging after an approval is revoked or guest intake is disabled. This is a destructive setting; an authorised adult operator must enable it only after reviewing each hotel's policy.
- `RETENTION_ENFORCEMENT_VERIFIED=true`: set only after the worker, monitoring and backup-retention/deletion behavior have been tested and reviewed. This is not verified yet.
- `STAFF_HANDOFF_TESTED=true`: set only after a real staff notification and manual fallback have both been tested.
- `PILOT_RELEASE_APPROVED=true`: final release approval after all evidence above and each hotel's approval record are reviewed. Never set these flags just to make the dashboard green.
- Per-hotel written privacy approval is recorded only by a platform operator after reviewing the hotel's written approval: `POST /api/platform/organizations/:slug/privacy-approval` with the `X-Platform-Provisioning-Token` header and an `approvalReference` plus `retentionDays` body field. `DELETE` on the same path revokes new guest-chat approval but preserves the retention schedule so existing data continues to be purged. The record does not prove that backup retention or all legal deletion obligations are satisfied.

Never commit secrets or place them in browser JavaScript.

## Initial workspace setup

1. A parent or guardian should manage the hosting account, provider billing and any paid upgrade.
2. Confirm the Render service has `DATABASE_URL` configured and `/api/health` reports `database: connected`. Check `/api/readiness` separately; it will remain degraded until every pilot requirement is satisfied.
3. Add the AI provider key in Render's service environment. Do not paste secrets into chat or GitHub.
4. Use `/setup.html` with the one-time bootstrap token to create the first owner.
5. Remove `BOOTSTRAP_TOKEN` from Render and redeploy.
6. For each additional hotel, a trusted platform operator must provision a separate workspace through `POST /api/platform/organizations` using the `PLATFORM_PROVISIONING_TOKEN` header. Give that hotel's owner their own workspace slug and credentials; never share one hotel's login or storage authorization with another.
7. Sign in at `/dashboard.html` using the workspace slug shown by the setup page, plus the owner email and password.
8. Add hotel knowledge as unapproved; a hotel manager must verify it before approval.
9. Set `ALLOWED_ORIGINS` to the exact hotel website origin.
10. Test the staff notification receiver and its fallback process.
11. Keep guest-data storage disabled until platform-wide privacy review, a platform-operator record of this hotel's written approval, durable backups and automated retention/deletion are all verified. The retention-enforcement gate is not yet satisfied.
12. Embed the widget on the hotel site:

    ```html
    <script src="https://veyra-ai-prototype.onrender.com/widget.js"
            data-veyra-slug="your-hotel-slug"
            data-veyra-api="https://veyra-ai-prototype.onrender.com"
            async></script>
    ```

## API endpoints

- `GET /api/health` — process health for the hosting platform; returns HTTP 200 while reporting dependency status
- `GET /api/readiness` — platform-wide release readiness; per-hotel readiness is combined with this by `GET /api/admin/onboarding`
- `POST /api/setup/organization` — one-time first-owner bootstrap
- `POST /api/platform/organizations` — protected creation of additional hotel workspaces and owner accounts
- `POST /api/platform/organizations/:slug/privacy-approval` — platform-operator-only record of a hotel's written approval and retention target
- `DELETE /api/platform/organizations/:slug/privacy-approval` — revoke that hotel's approval record
- `POST /api/admin/integrations/test-ai` — owner/admin verifies the configured AI model for the current hotel
- `POST /api/admin/integrations/test-staff-webhook` — owner/admin sends a signed, guest-data-free test event for the current hotel
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET/POST/DELETE /api/admin/invitations` — owner/admin invitation management
- `GET /api/admin/users` and `PATCH /api/admin/users/:id` — view team and activate/deactivate access
- `GET /api/admin/storage/connections` — workspace-specific storage connection status
- `POST /api/admin/storage/connect/google|microsoft` — start provider OAuth
- `GET /api/admin/storage/oauth/callback` — one-time OAuth callback
- `GET /api/admin/storage/sites/microsoft` — discover SharePoint sites
- `GET /api/admin/storage/files/google|microsoft` — list supported documents (optional `siteId` for SharePoint)
- `POST /api/admin/storage/import/google|microsoft` — import one selected document as unapproved knowledge
- `DELETE /api/admin/storage/connections/google|microsoft` — disconnect and delete stored provider tokens
- `GET /api/admin/audit` — latest 100 tenant-scoped audit events for owners/admins
- `GET/PUT /api/admin/settings` — hotel profile settings (owner/admin can edit)
- `GET /api/admin/onboarding` — live pre-pilot readiness checks
- `POST /api/invitations/accept` — single-use invitation acceptance
- `GET /api/auth/me`
- `GET /api/auth/csrf`
- `GET /api/admin/conversations/:id` — tenant-scoped conversation transcript
- `DELETE /api/admin/conversations/:id` — owner/admin-only, tenant-scoped conversation deletion
- `GET /api/admin/overview` — tenant-scoped dashboard metrics and recent conversations
- `GET/POST /api/admin/knowledge`
- `PATCH/DELETE /api/admin/knowledge/:id` — update, reapprove or delete knowledge; edits remove approval
- `GET /api/admin/knowledge/:id/versions` — review history including source and review metadata
- `GET /api/admin/escalations`
- `POST /api/admin/escalations/:id/notify` — retry a failed notification (maximum five attempts)
- `PATCH /api/admin/escalations/:id`
- `POST /api/public/:slug/chat`

## Not yet approved for a real hotel pilot

This is an active prototype, not a certified or production-approved hotel system. Before real guest use, it still needs:

- Durable paid database hosting, automated backups and a successful restore drill.
- Platform-wide privacy review and a separate written approval record for every hotel; one hotel's approval must never unlock another hotel's workspace.
- Automated per-hotel retention/deletion enforcement, durable paid database hosting, backups and a successful restore drill.
- Verified hotel knowledge, source/version history and named approval responsibility.
- Verified staff notification integration, retries, delivery audit and an operational fallback.
- Email verification, password recovery, MFA and session/device management.
- Finish storage connector hardening and tests: Microsoft tenant consent and real SharePoint library coverage, provider pagination, large-file streaming, Word/PDF/Excel extraction, automated incremental sync/webhooks and revoked-token handling.
- Expand tenant-isolation tests to every sensitive route and table; add prompt-injection, abuse, external-provider, backup/restore, security-review and sustained load tests.
- Monitoring, incident response, hotel manager sign-off and a supervised pilot measured against a baseline.

Never promise a booking, refund, room availability, completed notification, staff replacement or revenue improvement unless the required integration and result have actually been verified.


Knowledge documents retain a version history. The dashboard can review saved versions, and history access is restricted to the document's hotel workspace. Content edits automatically revoke approval until reverified.
