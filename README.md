# Veyra AI

Veyra AI is a hotel customer-support platform prototype. It is designed to answer guest questions using hotel-approved information and route uncertain or sensitive requests to staff.

## Live project

- Public demo site: https://veyra-ai-prototype.onrender.com
- Owner dashboard: https://veyra-ai-prototype.onrender.com/dashboard.html
- First workspace setup: https://veyra-ai-prototype.onrender.com/setup.html
- Source code: https://github.com/bruski1414-boop/Instant-support-ai.

## Current deployment

The Render web service is connected to PostgreSQL. GitHub Actions CI runs on Node.js 20 with a temporary PostgreSQL 16 service and executes the complete test suite, including a live two-hotel API isolation test. A successful deployment or CI run is useful evidence, but neither certifies the product for real guest data or a hotel launch.

The web service and database are currently on Render's free plans. The database is scheduled to expire on 11 December 2026. Render Free Postgres has no managed backups, logical exports, or point-in-time recovery; its data can be deleted after the expiry grace period. External database connections are currently blocked by an empty IP allowlist. Do not put real hotel or guest data into this environment. A parent or guardian must manage hosting accounts, any paid upgrades, database credentials, and provider billing. See [the database backup and restore runbook](docs/database-backup-restore.md).

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
- Per-hotel staff notification endpoints: each hotel owner/admin configures its own HTTPS receiver and signing secret. Endpoint and secret are encrypted at rest with a dedicated AES-256-GCM key, never returned by dashboard APIs, verified by a signed test event, and removed independently per hotel. Webhook DNS is checked against private/reserved IP ranges and the outbound HTTPS request pins the validated public IP and refuses redirects.
- Knowledge source references and review dates, with overdue documents automatically excluded from guest-answer context until reviewed.
- Owner dashboard for conversations, knowledge approval and escalation status.
- Embeddable guest chat widget with multi-turn conversation continuity, bounded history and a per-conversation access token stored only as a hash server-side.
- Public file allowlist so source files, tests and internal documentation are not served as website assets.
- Baseline browser security headers (content-type sniffing, framing, referrer and permissions policies).
- Tenant-scoped owner/admin conversation deletion from active database records (backup/provider retention may differ) with an audit record.
- Tenant-scoped, read-only Google Drive and Microsoft OneDrive/SharePoint OAuth connectors. OAuth tokens are encrypted at rest with AES-256-GCM; each workspace stores its own provider connection; OAuth state is single-use and expires after ten minutes.
- Hotel owners/admins can browse plain-text documents and Google Docs, choose individual files, and import them into that hotel's knowledge base. Imports are unapproved by default and must be manager-verified before guest use. SharePoint site discovery and site-root text-file browsing are included.
- AI answer generation constrained to each hotel's approved knowledge, with conservative escalation for uncertain or sensitive requests.
- Relevance-aware approved-knowledge context selection: preserves the full knowledge set when it fits, otherwise ranks complete documents against the guest question using title/category/content matches and conservative hotel FAQ terminology expansion. A separate evidence check requires every meaningful query term (or an approved synonym) to be represented in the hotel's approved documents before the model is called, even when the full knowledge set fits. It does not truncate documents mid-fact; unsupported details trigger a deterministic staff handoff rather than a model guess. This is conservative lexical matching, not semantic understanding; run the synthetic evaluation suite and then test against each hotel's approved FAQ wording before a pilot.
- A post-generation numeric-claim guard checks digit-form numbers and currency markers in a proposed answer against question-specific matched hotel documents and matched verified offers; unrelated documents cannot validate a coincidentally repeated number. If it finds a new value or currency, the answer is replaced with a staff handoff. This is a narrow safety check, not general fact verification: it does not prove non-numeric statements are correct.
- The deterministic `hotel-answer-evaluation.js` runner exercises the real retrieval and answer-policy path with mocked AI responses. Its fictional 10-document suite contains 22 scenarios: 10 supported questions, 10 unsupported questions, one numeric hallucination regression and one non-numeric invented-location regression. A separate end-to-end regression also verifies that a beach fact in a different approved document cannot be combined with the breakfast fact to invent a relationship. Passing these tests verifies only the tested scenarios; they are not a live model benchmark or a substitute for hotel-specific human review. The post-generation non-numeric check requires each generated clause's descriptive terms to co-occur in one approved evidence sentence, reducing cross-sentence fact borrowing. This remains a lexical heuristic, not semantic entailment: it cannot reliably verify negation, contradictions, implication or factual relationships, and may reject valid paraphrases.
- Signed, hotel-specific staff webhooks with persisted delivery status, attempt count and a dashboard retry action for failed notifications. A missing or failed webhook always leaves a manual staff follow-up requirement.
- Provider-independent PMS adapter framework with a strict adapter contract for connection tests, availability lookup, booking creation and webhook verification; normalized date, availability and booking payloads; and a sandbox adapter. Sandbox checks are explicitly marked non-production and do not claim live inventory or create bookings. No live PMS vendor adapter is connected yet.
- Separate rate limits for public guest chat and first-owner bootstrap.
- Guest conversation storage is disabled by default until privacy and retention arrangements are approved.
- GitHub Actions CI runs syntax checks and Node's test suite against PostgreSQL 16. The two-hotel integration test provisions separate workspaces, signs in as both owners, checks tenant separation across knowledge, settings, staff, audit events, storage connections, conversations, escalations and encrypted staff-webhook configuration, attempts cross-tenant reads/edits/deletes, verifies distinct website CORS origins and sends concurrent dashboard requests. Unit tests cover webhook encryption, URL validation, signed payload delivery and failure handling. Live Google/Microsoft OAuth, real provider credentials, real hotel notification receivers, backup/restore and sustained load testing remain outstanding.

## PMS integration framework

The PMS layer is deliberately provider-independent so a hotel can select its existing property-management or booking system before a vendor-specific connector is added. The adapter contract is in `pms-integration.js`. Each production adapter must implement a connection test and explicitly declare support for availability lookup, booking creation and webhook verification. Provider responses are normalized before they can enter Veyra's application layer; date ranges, currencies, inventory counts, booking statuses and idempotency keys are validated.

The hotel setup dashboard exposes the installed adapter catalog and a sandbox contract test. The sandbox only proves that Veyra's adapter interface and tenant-scoped test recording work. It does **not** connect to a hotel's PMS, return live availability, confirm reservations or create bookings. The adapter contract now also requires provider-specific webhook signature verification against the original request bytes, includes a reusable timestamp-bound HMAC-SHA256 verifier with constant-time signature comparison, normalizes event IDs/types/timestamps, limits event payload size, and provides a tenant-scoped idempotent event inbox that stores only a payload hash and event metadata (not guest payload contents). The HMAC helper is only suitable for providers using that exact signing format; adapters must implement the vendor's documented scheme rather than assuming all PMS vendors use it. These are reusable foundations, not a live webhook endpoint: no production PMS vendor adapter, provider secret, credential connection or event processor is configured. A real connection requires the hotel to identify its provider, obtain an authorised sandbox/API account and approve the required scopes. Only then can its exact signature scheme, encrypted credential storage, ingress route, event mapping and end-to-end booking tests be implemented. The per-hotel connection metadata table is tenant-scoped, the status API omits encrypted credentials and raw provider error details, and a fresh successful production adapter test is required before the dashboard reports a production connection. Credential encryption uses a separate `PMS_CREDENTIAL_ENCRYPTION_KEY` (base64-encoded 32-byte key); it must be provisioned by an authorised adult/operator and must never be committed or shared in chat. Provider selection and onboarding prerequisites are recorded in `docs/pms-provider-onboarding.md`.

## Provisioning additional hotels

A trusted platform operator (not a hotel guest and not a hotel workspace user) can create a hotel workspace using the Node.js 20 CLI. The Render account owner must first add a high-entropy `PLATFORM_PROVISIONING_TOKEN` to the service's secret environment variables. Never put that token in dashboard JavaScript, a public page, a GitHub commit, or a hotel owner's browser.

Set these environment variables in a secure operator shell: `VEYRA_BASE_URL`, `PLATFORM_PROVISIONING_TOKEN`, `HOTEL_NAME`, `HOTEL_OWNER_EMAIL`, and `HOTEL_OWNER_PASSWORD`. Then run `npm run provision:hotel`. The script prints the new workspace slug and owner email, but never prints the password or token. Deliver credentials to the hotel owner through a secure channel and remove the temporary shell variables afterwards. A parent/guardian or authorized adult must manage hosting credentials and any paid account changes.

Each hotel owner then signs in to its own workspace, saves the hotel's HTTPS website origin and staff contact, authorizes that hotel's own Google Drive or Microsoft account, imports information for manager review, and configures its own staff webhook. The AI test requires a valid server-side `OPENAI_API_KEY`; the staff test requires that hotel's own HTTPS receiver and signing secret. The receiver must accept Veyra's JSON event and verify the `x-veyra-signature` HMAC-SHA256 header. Do not enable guest-data storage or mark pilot release gates complete until written hotel approval, durable backups, restore testing, privacy/retention terms and staff procedures are in place.

## Runtime configuration

The Render service currently starts with PostgreSQL connected. Live AI responses require a server-side `OPENAI_API_KEY`. Staff notifications require a platform-level `STAFF_WEBHOOK_ENCRYPTION_KEY` plus a separately configured, verified webhook URL and signing secret for each hotel workspace.

Important environment variables:
- `DATABASE_URL`: Render Postgres internal connection string.
- `DATABASE_SSL`: defaults to TLS enabled.
- `OPENAI_API_KEY`: provider secret stored only in Render.
- `OPENAI_MODEL`: defaults to `gpt-4.1-mini`.
- `BOOTSTRAP_TOKEN`: one-time first-workspace setup secret; remove it after the first owner is created.
- `PLATFORM_PROVISIONING_TOKEN`: separate high-entropy server-side secret required to create each additional hotel workspace through `POST /api/platform/organizations`. Keep it only in hosting secrets and never put it in browser code or public documentation.
- `ALLOWED_ORIGINS`: exact platform/admin origins permitted to call the API. A hotel's own saved HTTPS origin is also dynamically allowed for its own embeddable guest widget.
- `GUEST_DATA_STORAGE_ENABLED`: defaults to false. Do not enable until hotel privacy, data-processing and retention arrangements are approved and durable storage is in place.
- `STORAGE_OAUTH_REDIRECT_BASE`: public HTTPS origin of this Veyra deployment, for example `https://veyra-ai-prototype.onrender.com`.
- `STORAGE_TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte random key used for AES-256-GCM encryption of per-hotel OAuth tokens. Keep only in hosting secrets; never commit it.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`: Google OAuth web application credentials. Register callback `https://<veyra-origin>/api/admin/storage/oauth/callback` and enable the Google Drive API.
- `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET`: Microsoft Entra application credentials. Register the same callback as a Web redirect URI and grant admin-approved delegated permissions `Files.Read.All`, `Sites.Read.All`, `User.Read`, and `offline_access`.
- `STAFF_WEBHOOK_ENCRYPTION_KEY`: base64-encoded random 32-byte key used only to encrypt each hotel's webhook URL and signing secret with AES-256-GCM. Generate with `openssl rand -base64 32`, add it only to Render's secret environment variables, and never commit or share it. Rotating this key requires a controlled re-encryption of every stored hotel webhook configuration; do not rotate it casually.\n- `DURABLE_BACKUPS_VERIFIED=true`: set only after a durable backup and restore test is documented.\n- `TENANT_ISOLATION_TESTS_PASSED=true`: set only after automated tests prove cross-hotel data isolation.\n- `PROVIDER_OAUTH_TESTED=true`: set only after Google/Microsoft OAuth and document access are tested with separate test tenants.\n- `HOTEL_PRIVACY_APPROVED=true`: set only after the pilot hotel has approved its privacy and retention arrangements in writing.\n- `STAFF_HANDOFF_TESTED=true`: set only after a real staff notification and manual fallback have both been tested.\n- `PILOT_RELEASE_APPROVED=true`: final release approval after all evidence above is reviewed. Never set these flags just to make the dashboard green.

Never commit secrets or place them in browser JavaScript.

## Initial workspace setup

1. A parent or guardian should manage the hosting account, provider billing and any paid upgrade.
2. Confirm the Render service has `DATABASE_URL` configured and `/api/health` reports `database: connected`. Check `/api/readiness` separately; it will remain degraded until every pilot requirement is satisfied.
3. Add the AI provider key in Render's service environment. Do not paste secrets into chat or GitHub.
4. Use `/setup.html` with the one-time bootstrap token to create the first owner.
5. Remove `BOOTSTRAP_TOKEN` from Render and redeploy.
6. For each additional hotel, a trusted platform operator must provision a separate workspace through `POST /api/platform/organizations` using the `PLATFORM_PROVISIONING_TOKEN` header. Give that hotel's owner their own workspace slug and credentials; never share one hotel's login or storage authorization with another.
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
- `POST /api/setup/organization` — one-time first-owner bootstrap
- `POST /api/platform/organizations` — protected creation of additional hotel workspaces and owner accounts
- `POST /api/admin/integrations/test-ai` — owner/admin verifies the configured AI model for the current hotel
- `GET /api/admin/integrations/staff-webhook` — returns only this hotel's webhook configuration status, never its URL or secret
- `PUT /api/admin/integrations/staff-webhook` — owner/admin saves this hotel's HTTPS endpoint and signing secret; resets verification
- `DELETE /api/admin/integrations/staff-webhook` — owner/admin removes only this hotel's endpoint and verification
- `POST /api/admin/integrations/test-staff-webhook` — owner/admin sends a signed, guest-data-free test event to this hotel's receiver
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
- `DELETE /api/admin/storage/connections/google|microsoft` — disconnect and delete stored provider tokens\n- `DELETE /api/admin/storage/imports/google|microsoft` — owner/admin-only, requires `{ confirm: true }`, and transactionally deletes only that hotel's imported knowledge copies and their version history from the selected provider; source files in the hotel's own storage are not changed
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
- Expand tenant-isolation tests to every sensitive route and table; add prompt-injection, abuse, external-provider, backup/restore, security-review and sustained load tests.
- Monitoring, incident response, hotel manager sign-off and a supervised pilot measured against a baseline.

Never promise a booking, refund, room availability, completed notification, staff replacement or revenue improvement unless the required integration and result have actually been verified.


Knowledge documents retain a version history. The dashboard can review saved versions, and history access is restricted to the document's hotel workspace. Content edits automatically revoke approval until reverified.
