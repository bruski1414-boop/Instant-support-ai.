# Veyra AI — Customer Support MVP

Veyra AI is an early customer-support assistant prototype aimed at hospitality and service businesses.

## What is in this repository now

- Premium Veyra AI landing page and sample hotel chat.
- Express backend (server.js) with a live AI chat endpoint.
- OpenAI API key stays on the server in an environment variable.
- Business-specific FAQ/context injected into the AI system prompt.
- Basic request validation and API rate limiting.
- Conservative escalation rules for sensitive or uncertain requests.
- Tenant-specific Slack handoff notifications with AES-256-GCM encrypted webhook storage, owner/admin setup, test delivery, and disconnect controls.
- Tenant-scoped staff handoff inbox in the authenticated dashboard, with queue refresh, conversation review, internal staff notes, and resolution. Staff notes are not delivered to guests; there is no outbound guest-reply channel yet.
- Security headers, bounded request/history sizes, API timeout, and restricted public routes.
- Staff webhook destinations restricted to Slack's official incoming-webhook hosts; redirects are blocked to reduce SSRF risk.
- Built-in Node test suite (`npm test`) with GitHub Actions CI.
- Opt-in live-model evaluation (`npm run test:live`) using fictional hotel facts and synthetic questions.
- Demo responses when the live backend is not configured.

## Important: prototype, not production SaaS

This is an early tenant-aware MVP codebase, not a production-ready hotel service. Passing CI does not establish live deployment, AI answer accuracy, security certification, operational coverage, or hotel readiness. It does not yet include:
- Tenant-scoped workspace discovery, knowledge-document drafts and approvals, conversation storage, staff notes, and a public tenant-specific guest chat endpoint are implemented and covered by disposable-PostgreSQL integration tests. Live database provisioning, service encryption-key configuration, retention/deletion controls, and independent production security review remain outstanding.
- Native staff email/SMS/WhatsApp integrations; tenant-specific Slack incoming webhooks are implemented, but email/SMS/WhatsApp channels are not.
- Booking, CRM, hotel PMS, Shopify, or payment integrations.
- A workspace dashboard for managing knowledge drafts/approvals and viewing stored conversations is implemented; it is not yet connected to PMS, booking, billing, or real-time staff messaging.
- Billing, subscription management, independently reviewed operational audit processes, or enterprise SLAs.
- Production monitoring and independent security review.

Do not promise those features to customers until they are implemented and tested. Pricing needs to be justified by proven business value, reliability, support, and integrations—not by the number of AI features listed.

## Prototype deployment (not a hotel launch)

This repository includes a Render Blueprint in `render.yaml`. **Do not deploy this branch to a real hotel's website or enable guest traffic yet.** Use a new isolated staging service only after an authorised adult/operator has approved the costs, database, secrets, privacy, and security plan. Follow [`docs/hotel-pilot-runbook.md`](docs/hotel-pilot-runbook.md).

1. A parent/guardian should help create or manage any hosting and AI-provider accounts, review billing, and approve API usage.
2. Open Render and choose **New → Blueprint** (or connect the GitHub repository and create a Blueprint).
3. Select this repository and review the service settings in `render.yaml`.
4. In the Render service's Environment settings, add `OPENAI_API_KEY` as a secret. Never paste it into GitHub, website JavaScript, chat messages, or screenshots.
5. Set `TENANT_INTEGRATION_ENCRYPTION_KEY` to a randomly generated 32-byte key encoded as base64 in the hosting provider's secret environment settings. Keep it backed up securely: losing it makes stored tenant webhook credentials undecryptable. A parent/guardian or authorised operator should manage this key. Hotel owners/admins can then configure their own Slack incoming webhook in the dashboard; Veyra accepts only HTTPS Slack incoming-webhook hosts and never forwards guest message content.
6. Add the real business's approved FAQ and business name only after receiving permission.
7. Deploy, then open the service's `/api/health` endpoint and test the chat with non-sensitive sample questions.

Render's free web services may sleep after inactivity and take time to wake up. AI-provider usage may still cost money. A free hosting tier does not mean unlimited or free AI requests. Review current hosting and API prices before enabling customer traffic.

The code now contains tenant-aware workspace and guest-chat foundations, but it has not been deployed or independently reviewed in a live environment. Do not connect real guest data or promise service-level guarantees until staging, security/privacy review, backups, monitoring, and a supervised pilot are complete.

## Authentication foundation

The backend now has database-backed `POST /api/auth/login`, `GET /api/auth/me`, and `POST /api/auth/logout` endpoints when `DATABASE_URL` is configured. Authenticated workspace APIs expose `GET /api/workspaces`, `GET/POST /api/knowledge`, `POST /api/knowledge/:id/approve`, and tenant-scoped conversation list/create/detail/staff-message routes. Each dashboard data request validates the selected workspace against the signed-in user's membership and applies transaction-local tenant context for PostgreSQL row-level security. The public `POST /api/public/:tenantId/chat` endpoint uses only approved knowledge for that tenant, persists guest and assistant messages, and queues conversations requiring human review in the dashboard. A website launcher is available at `/widget.js?workspace=<tenant-id>` with its stylesheet at `/widget.css`; it adds a floating button that opens the hosted guest chat in a new tab (not an iframe). Workspace owners/admins must first save exact HTTPS origins in the dashboard. The launcher endpoint checks the referring origin against the tenant allowlist and does not cache the script response. Hotels with strict CSP must allow the Veyra origin in `script-src` and `style-src`. Conversation retention defaults to 90 days; workspace owners/admins can choose 30–730 days. Expired conversations and associated messages are purged on workspace access, with a tenant audit event recording the deletion count. The public `/login.html` page submits credentials to the login endpoint, and `/dashboard.html` is served only after the server validates an active session and at least one active workspace membership. The dashboard shows the authenticated email and membership roles and provides CSRF-protected sign-out. Passwords are verified with Node's scrypt implementation; only opaque random session tokens are sent in HttpOnly cookies and SHA-256 token hashes are stored in PostgreSQL. Sessions expire after eight hours and can be revoked. All authenticated POST/PUT/PATCH/DELETE workspace routes require a valid CSRF token and same-origin request; login/logout also validate origin. Login attempts have a dedicated rate limit.

Apply migrations in order: `001_multi_tenant_foundation.sql`, `002_authentication.sql`, then `003_tenant_integrations.sql`, then `004_privacy_retention.sql`, then `005_widget_domains.sql`. Set `APP_ORIGIN` to the exact HTTPS site origin in production. Set `DATABASE_SSL=true` only when the database provider supports verified TLS. There is deliberately no public sign-up endpoint. On a completely empty database, a parent/guardian or authorised database administrator can run `npm run provision:owner` from a trusted terminal with `PROVISION_DATABASE_URL` set to a separate privileged connection. The script prompts for the owner email, organisation name, and password without echoing the password; it refuses to run if any organisation or user already exists. Never expose this privileged connection to the running web service. No default credentials are created.

**This is not yet production authentication.** The routes have not been tested against a live hosted database, the first-owner provisioning workflow has not been run against a real database, the live database has not been provisioned or tested on a hosted environment, tenant-specific Slack notifications are implemented but require a service encryption key and an owner/admin-configured webhook, and public guest chat has not been deployed or tested with a real hotel. Do not use real accounts or guest data until those items and an independent security review are complete.

## Health and readiness

- `GET /api/health` checks whether the process is responding and reports whether live AI configuration is present. A `degraded` status means the process is up but not ready to answer guests.
- `GET /api/ready` returns HTTP 200 only when the AI client is configured, PostgreSQL is reachable, all tenant tables and forced RLS policies exist, and the connected database role is restricted and does not own application tables. Otherwise it returns HTTP 503 with non-secret check results. This is a readiness check, not proof that the AI provider is reachable or that answers are accurate.

## Run tests

Run `npm test` with Node.js 20 or newer. GitHub Actions runs this suite on pushes and pull requests, then starts disposable PostgreSQL 16, applies all five migrations, verifies row-level tenant isolation with a restricted database role, and exercises login, profile lookup, CSRF-protected logout, and session revocation against that role. The PostgreSQL integration check uses two synthetic hotels and a restricted runtime role to test workspace membership, knowledge draft/approval, cross-tenant denial, encrypted tenant Slack integration setup and simulated delivery, owner-managed HTTPS website origin allowlists, approved and rejected launcher requests, CSRF validation, conversation storage, staff messages, public guest chat with a fake AI provider, and escalated conversations entering and leaving the authenticated staff handoff inbox. The Node suite also covers backend routes, password hashing, the OpenAI SDK request path using a controlled fake transport, prompt-injection handling, response schema validation, handoff delivery outcomes, frontend script parsing, rate limiting, and blocked access to private source/configuration files.

For a separate real-model check, run `npm run test:live` only after a parent/guardian has approved the API account and any usage charges, and after setting `OPENAI_API_KEY`. This sends fifteen synthetic questions about the shared fictional Northstar Hotel fixture through the live model. It does not use real guest data, is not run automatically in CI, and may incur API charges. A passing live evaluation is still not proof of production readiness.

## Run locally

Requirements: Node.js 20 or newer.

1. Install dependencies with: npm install
2. Copy .env.example to .env.
3. Add your OpenAI API key to .env. Keep the key private and never commit .env.
4. Configure BUSINESS_NAME and BUSINESS_FAQ with information approved by the business.
5. Start the server with: npm start
6. Open http://localhost:3000.

Without an API key, the website still displays sample demo responses, but the backend returns a setup message instead of calling a live AI model.

## Environment variables

- TENANT_INTEGRATION_ENCRYPTION_KEY: required 32-byte base64-encoded key used to encrypt tenant-specific Slack webhook credentials with AES-256-GCM. Configure only as a hosting-provider secret; do not commit it. Losing the key prevents decryption of saved credentials.
- DATABASE_URL: private PostgreSQL connection string used by account/session endpoints.
- DATABASE_SSL: set to true only when verified TLS is required and supported.
- APP_ORIGIN: exact public origin used to validate login/logout requests in production.
- OPENAI_API_KEY: server-side secret; required for live AI.
- OPENAI_MODEL: model name, default gpt-4.1-mini.
- PORT: server port, default 3000.
- BUSINESS_NAME: business name used by the assistant.
- BUSINESS_FAQ: approved facts and policies for the business.

## Production deployment preflight

Before connecting a hosted database or enabling customer traffic, run `npm run preflight:production` from a trusted terminal with the production environment variables available. The check verifies that the application is using a separate, non-superuser, non-BYPASSRLS database login; that the required tables and forced row-level security policies exist; that the app login does not own its tables; and that production secrets, the HTTPS app origin, and the 32-byte integration-encryption key are configured. It reports missing configuration without printing secret values or database connection strings. It does not replace a security review, backups/restore test, live-provider evaluation, or a real staging deployment.

The application service must use a dedicated restricted runtime database login. A separate authorised database administrator must apply migrations and provision the first owner; never give the web service the database-owner connection string. Do not run the preflight against a database containing real guest information until an authorised adult/operator has reviewed the configuration.

## Fictional hotel demo and guest scenarios\n\nThe shared demo fixture is in `fixtures/northstar-hotel.js`. It defines fictional check-in/check-out, breakfast, pool and fitness-room facts, while explicitly leaving Wi-Fi credentials, room rates, room availability, pet policy, parking policy and dinner-menu details unverified. `npm test` includes offline checks for this fixture and deterministic staff-escalation rules. `npm run test:live` evaluates 15 synthetic guest questions covering known FAQs, unknown facts, booking and refund requests, allergies, complaints, prompt injection and false booking claims. Live evaluation is opt-in and may incur AI-provider charges; it does not test a live hotel or real guest data.\n\n## Browser end-to-end checks

The CI workflow installs a pinned Playwright version and Chromium to exercise the guest chat and hosted launcher in a real browser. These tests use a local static server and mocked chat responses; they do not verify the live hotel database, live AI provider, real Slack delivery, production hosting, or a hotel's actual website.

## Next engineering milestones

1. Prepare an isolated staging environment with a hosted database, dedicated restricted runtime login, secrets, and a first owner provisioned by an authorised adult/operator.
2. Run `npm run preflight:production`, then verify the deployed health/readiness endpoints and database-backed login, knowledge approval, guest chat, staff handoff, and website launcher.
3. Run the live-model evaluation only after an adult account owner approves the AI-provider account and usage budget; use fictional hotel facts and synthetic questions only.
4. Test backup restoration, privacy/deletion behavior, alert delivery, and operational monitoring.
5. Complete an independent security/privacy review and a supervised pilot with one hotel before using real guest data or making ROI claims.
6. Improve delivery retries, source-grounded answer evaluation, and explainable analytics based on pilot evidence.

## Safety and reliability principles

- Never invent prices, room availability, booking confirmations, refund decisions, or business policies.
- Escalate uncertain, urgent, sensitive, or complaint-related requests to staff.
- Do not put API keys in frontend JavaScript or public GitHub files.
- Use only customer information that the business has permission to provide.
- Keep a human responsible for consequential decisions.


## Hotel pilot readiness

The current build is **not approved for hotel guest traffic**. It has no live hosted database or staging deployment, the live-model evaluation has not been run, and there has been no independent security/privacy review. It also has no PMS/booking/payment integrations, no outbound staff-to-guest reply channel, no scheduled retention purge, and no customer data-export workflow. Use the supervised checklist in [`docs/hotel-pilot-runbook.md`](docs/hotel-pilot-runbook.md); do not treat a green CI run as permission to launch.
