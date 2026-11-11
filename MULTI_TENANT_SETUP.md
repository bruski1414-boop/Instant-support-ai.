# Veyra AI multi-tenant backend

## Implemented
- PostgreSQL tenant schema: organizations, users, sessions, approved knowledge, conversations, messages, escalations and audit logs.
- Tenant-scoped admin APIs for metrics, knowledge and escalations.
- Password hashing using scrypt, random opaque session tokens stored as SHA-256 hashes, HttpOnly/SameSite cookies, CSRF checks, session expiry and role checks.
- One-time first-owner bootstrap endpoint.
- Hotel-specific public AI endpoint: POST /api/public/:slug/chat. It uses only that hotel's approved knowledge.
- Sensitive and uncertain requests are escalated. Optional signed webhook notification reports delivery honestly.
- Health endpoint reports database and AI configuration. Legacy single-business chat is disabled when DATABASE_URL is configured.

## Deployment still required
A free Render PostgreSQL instance was created in Singapore. It expires after 30 days unless upgraded. Do not store real guest data in this temporary database. A parent/guardian should review paid upgrades, hosting and provider billing.

In Render service Environment, configure:
- DATABASE_URL: internal connection string from the Postgres dashboard (same workspace and region).
- DATABASE_SSL=true
- OPENAI_API_KEY: provider secret; never put it in GitHub or frontend code.
- OPENAI_MODEL=gpt-4.1-mini
- BOOTSTRAP_TOKEN: long random one-time setup secret. Remove it after owner setup.
- ALLOWED_ORIGINS: exact trusted website origins.
- NODE_ENV=production
- STAFF_WEBHOOK_URL and STAFF_WEBHOOK_SECRET: optional signed notification receiver. Without both, escalations are recorded but no staff message is sent.

## First setup
1. Wait until Postgres is available; connect its internal URL as DATABASE_URL in Render.
2. Confirm /api/health reports database=connected.
3. POST /api/setup/organization with X-Bootstrap-Token and JSON { "organizationName":"...", "email":"...", "password":"12+ characters" }.
4. Remove BOOTSTRAP_TOKEN and redeploy.
5. POST /api/auth/login; retain returned csrfToken in page memory and send it as X-CSRF-Token on state-changing authenticated calls. Session cookie is HttpOnly.
6. GET /api/auth/me confirms the workspace.
7. Add knowledge with POST /api/admin/knowledge. Hotel manager must verify the facts before approved=true.
8. Configure GUEST_DATA_STORAGE_ENABLED=true only after the hotel has approved its privacy notice, data-processing terms and retention period, and a durable database is in place.
9. Set ALLOWED_ORIGINS to the hotel website origin and test the signed webhook.
10. Embed the guest widget with: `<script src="https://veyra-ai-prototype.onrender.com/widget.js" data-veyra-slug="your-hotel-slug" data-veyra-api="https://veyra-ai-prototype.onrender.com" async></script>`.
11. Publish the guest privacy notice before enabling conversation storage.

## API
- GET /api/health
- POST /api/setup/organization (one-time)
- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/me
- GET /api/admin/overview
- GET/POST /api/admin/knowledge
- PATCH/DELETE /api/admin/knowledge/:id
- GET /api/admin/escalations
- PATCH /api/admin/escalations/:id
- POST /api/public/:slug/chat

## Still needed before real hotel use
- Wire dashboard UI to APIs; staff invitations, password reset, verified email, MFA and session/device management.
- Guest privacy notice, data processing terms, consent where required, retention and deletion workflow.
- Knowledge source/version history and hotel approval workflow.
- Test the hotel's actual webhook receiver, retries, delivery audit, ownership and fallback route.
- Automated PostgreSQL integration tests, tenant isolation tests, prompt-injection tests, security review and load tests.
- Monitoring, backups, restore drill, incident response and hotel manager sign-off.
- Durable paid database plan before real customer data; current free database expires after 30 days.

Never claim a booking, refund, availability, notification or revenue result unless the relevant integration has completed and been verified.
