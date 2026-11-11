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
- Embeddable guest chat widget.
- Guest-data storage gate is disabled unless explicitly enabled after hotel privacy and retention approval.

## Render environment variables

The Render service has a connected PostgreSQL database. Confirm the following values in the Render service environment; never paste secret values into source control or chat.

- DATABASE_URL: internal connection string from the Render Postgres instance.
- DATABASE_SSL=true
- OPENAI_API_KEY: provider secret, server-side only.
- OPENAI_MODEL=gpt-4.1-mini
- BOOTSTRAP_TOKEN: long random one-time setup secret; remove after owner setup.
- ALLOWED_ORIGINS: exact trusted hotel website origins, comma-separated.
- NODE_ENV=production
- GUEST_DATA_STORAGE_ENABLED=false until privacy and retention approval and durable storage are in place.
- STAFF_WEBHOOK_URL and STAFF_WEBHOOK_SECRET: optional signed staff-notification receiver.

Without OPENAI_API_KEY, live AI responses are unavailable. Without both webhook settings, escalations are recorded but staff are not notified automatically.

## First owner setup

1. Confirm /api/health reports database=connected.
2. Use /setup.html with the one-time bootstrap token to create the first owner.
3. Remove BOOTSTRAP_TOKEN from the Render service environment and redeploy.
4. Sign in at /dashboard.html.
5. Add hotel knowledge as unapproved and have the hotel manager verify every fact before approval.
6. Set ALLOWED_ORIGINS to the exact hotel website origin.
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

- GET /api/health
- POST /api/setup/organization
- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/me
- GET /api/auth/csrf
- GET /api/admin/overview
- GET/POST /api/admin/knowledge
- PATCH/DELETE /api/admin/knowledge/:id
- GET /api/admin/escalations
- PATCH /api/admin/escalations/:id
- POST /api/public/:slug/chat

## Remaining before a real hotel pilot

- Replace temporary free database hosting with a durable plan; configure backups and prove restoration.
- Hotel-approved privacy notice, data-processing terms, lawful basis/consent where required, retention and deletion workflow.
- Verified knowledge source/version history and approval ownership.
- Test the hotel's actual signed webhook, retries, delivery audit and staff fallback.
- Email verification, password recovery, MFA, staff invitations and session/device management.
- PostgreSQL integration tests, tenant isolation tests, prompt-injection tests, abuse tests, security review and load tests.
- Monitoring, incident response, hotel manager sign-off and supervised pilot with baseline measurement.

Do not use real guest data or present this as production-ready until the hotel and responsible adults have approved the operational, legal, privacy and security requirements.
