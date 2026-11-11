# Veyra AI

Veyra AI is a hotel customer-support platform prototype. It is designed to answer guest questions using hotel-approved information and route uncertain or sensitive requests to staff.

## Live project

- Public demo site: https://veyra-ai-prototype.onrender.com
- Owner dashboard: https://veyra-ai-prototype.onrender.com/dashboard.html
- First workspace setup: https://veyra-ai-prototype.onrender.com/setup.html
- Source code: https://github.com/bruski1414-boop/Instant-support-ai.

## Current deployment

The Render web service is live and connected to its Render PostgreSQL database. The latest deployment and Veyra CI run completed successfully on 11 November 2026.

The web service and database are currently on Render's free plans. The database is temporary and is scheduled to expire on 11 December 2026. Do not put real hotel or guest data into this environment. A parent or guardian must manage hosting accounts, any paid upgrades and provider billing.

## Implemented foundation

- Express API and PostgreSQL multi-tenant schema.
- Organisation, user, session, approved-knowledge, conversation, message, escalation and audit-log tables.
- Tenant-scoped dashboard APIs for overview, knowledge and staff handoffs.
- Owner/admin/staff/viewer roles; scrypt password hashing; opaque session tokens; HttpOnly/SameSite cookies; CSRF checks; and session expiry.
- One-time first-owner bootstrap endpoint and setup page.
- Tenant-scoped staff invitations: hashed single-use tokens, 24-hour expiry, revocation, role restrictions and a dedicated acceptance page. Invitation delivery is manual; no email provider is connected.
- Workspace member management: owner/admin can deactivate staff accounts; deactivation revokes all active sessions. Admins cannot change owner or administrator access.
- Tenant-scoped security activity viewer for workspace owners and admins.
- Hotel workspace profile and live pre-pilot readiness checklist for website origin, approved knowledge, AI configuration, staff notification and privacy/storage gate.
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
- GitHub Actions CI and CI checks JavaScript syntax and runs Node's test discovery; the current repository has not yet established comprehensive API, frontend, provider-OAuth or tenant-isolation integration coverage.

## Runtime configuration

The Render service currently starts with PostgreSQL connected. Live AI responses require a server-side `OPENAI_API_KEY`; staff notifications require a verified `STAFF_WEBHOOK_URL` and matching `STAFF_WEBHOOK_SECRET`.

Important environment variables:
- `DATABASE_URL`: Render Postgres internal connection string.
- `DATABASE_SSL`: defaults to TLS enabled.
- `OPENAI_API_KEY`: provider secret stored only in Render.
- `OPENAI_MODEL`: defaults to `gpt-4.1-mini`.
- `BOOTSTRAP_TOKEN`: one-time setup secret; remove it after the first owner is created.
- `ALLOWED_ORIGINS`: exact website origins permitted to call the API.
- `GUEST_DATA_STORAGE_ENABLED`: defaults to false. Do not enable until hotel privacy, data-processing and retention arrangements are approved and durable storage is in place.
- `STORAGE_OAUTH_REDIRECT_BASE`: public HTTPS origin of this Veyra deployment, for example `https://veyra-ai-prototype.onrender.com`.
- `STORAGE_TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte random key used for AES-256-GCM encryption of per-hotel OAuth tokens. Keep only in hosting secrets; never commit it.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`: Google OAuth web application credentials. Register callback `https://<veyra-origin>/api/admin/storage/oauth/callback` and enable the Google Drive API.
- `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET`: Microsoft Entra application credentials. Register the same callback as a Web redirect URI and grant admin-approved delegated permissions `Files.Read.All`, `Sites.Read.All`, `User.Read`, and `offline_access`.
- `STAFF_WEBHOOK_URL` and `STAFF_WEBHOOK_SECRET`: optional signed escalation receiver.

Never commit secrets or place them in browser JavaScript.

## Initial workspace setup

1. A parent or guardian should manage the hosting account, provider billing and any paid upgrade.
2. Confirm the Render service has `DATABASE_URL` configured and `/api/health` reports `database: connected`. Check `/api/readiness` separately; it will remain degraded until every pilot requirement is satisfied.
3. Add the AI provider key in Render's service environment. Do not paste secrets into chat or GitHub.
4. Use `/setup.html` with the one-time bootstrap token to create the first owner.
5. Remove `BOOTSTRAP_TOKEN` from Render and redeploy.
6. Sign in at `/dashboard.html` using the workspace slug shown by the setup page, plus the owner email and password.
7. Add hotel knowledge as unapproved; a hotel manager must verify it before approval.
8. Set `ALLOWED_ORIGINS` to the exact hotel website origin.
9. Test the staff notification receiver and its fallback process.
10. Enable guest-data storage only after the hotel has approved its privacy notice, data-processing terms and retention period, and the database has durable backups and a restore plan.
11. Embed the widget on the hotel site:

    ```html
    <script src="https://veyra-ai-prototype.onrender.com/widget.js"
            data-veyra-slug="your-hotel-slug"
            data-veyra-api="https://veyra-ai-prototype.onrender.com"
            async></script>
    ```

## API endpoints

- `GET /api/health` — process health for the hosting platform; returns HTTP 200 while reporting dependency status
- `GET /api/readiness` — full hotel pilot readiness; returns HTTP 503 until all required checks pass
- `POST /api/setup/organization` — one-time owner bootstrap
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
- `GET /api/admin/conversations/:id` — tenant-scoped conversation transcript\n- `DELETE /api/admin/conversations/:id` — owner/admin-only, tenant-scoped conversation deletion\n- `GET /api/admin/overview`
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
- Hotel-approved privacy notice, data-processing terms, lawful basis/consent where required, retention and deletion workflow.
- Verified hotel knowledge, source/version history and named approval responsibility.
- Verified staff notification integration, retries, delivery audit and an operational fallback.
- Email verification, password recovery, MFA and session/device management.
- Finish storage connector hardening and tests: Microsoft tenant consent and real SharePoint library coverage, provider pagination, large-file streaming, Word/PDF/Excel extraction, automated incremental sync/webhooks and revoked-token handling.
- PostgreSQL integration tests, tenant-isolation tests, prompt-injection and abuse tests, security review and load tests.
- Monitoring, incident response, hotel manager sign-off and a supervised pilot measured against a baseline.

Never promise a booking, refund, room availability, completed notification, staff replacement or revenue improvement unless the required integration and result have actually been verified.


Knowledge documents retain a version history. The dashboard can review saved versions, and history access is restricted to the document's hotel workspace. Content edits automatically revoke approval until reverified.
