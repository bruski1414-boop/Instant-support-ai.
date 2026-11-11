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
- Owner dashboard for conversations, knowledge approval and escalation status.
- Embeddable guest chat widget with multi-turn conversation continuity and bounded history.
- Tenant-scoped owner/admin conversation deletion from active database records (backup/provider retention may differ) with an audit record.
- AI answer generation constrained to each hotel's approved knowledge, with conservative escalation for uncertain or sensitive requests.
- Optional signed staff webhook with persisted delivery status, attempt count and a dashboard retry action for failed notifications.
- Separate rate limits for public guest chat and first-owner bootstrap.
- Guest conversation storage is disabled by default until privacy and retention arrangements are approved.
- GitHub Actions CI and automated API/frontend smoke tests.

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
- `STAFF_WEBHOOK_URL` and `STAFF_WEBHOOK_SECRET`: optional signed escalation receiver.

Never commit secrets or place them in browser JavaScript.

## Initial workspace setup

1. A parent or guardian should manage the hosting account, provider billing and any paid upgrade.
2. Confirm the Render service has `DATABASE_URL` configured and `/api/health` reports `database: connected`.
3. Add the AI provider key in Render's service environment. Do not paste secrets into chat or GitHub.
4. Use `/setup.html` with the one-time bootstrap token to create the first owner.
5. Remove `BOOTSTRAP_TOKEN` from Render and redeploy.
6. Sign in at `/dashboard.html`.
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

- `GET /api/health`
- `POST /api/setup/organization` — one-time owner bootstrap
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/auth/csrf`
- `GET /api/admin/conversations/:id` — tenant-scoped conversation transcript\n- `DELETE /api/admin/conversations/:id` — owner/admin-only, tenant-scoped conversation deletion\n- `GET /api/admin/overview`
- `GET/POST /api/admin/knowledge`
- `PATCH/DELETE /api/admin/knowledge/:id`
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
- Email verification, password recovery, MFA, staff invitations and session/device management.
- PostgreSQL integration tests, tenant-isolation tests, prompt-injection and abuse tests, security review and load tests.
- Monitoring, incident response, hotel manager sign-off and a supervised pilot measured against a baseline.

Never promise a booking, refund, room availability, completed notification, staff replacement or revenue improvement unless the required integration and result have actually been verified.
