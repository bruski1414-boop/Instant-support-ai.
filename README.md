# Veyra AI — Customer Support MVP

Veyra AI is an early customer-support assistant prototype aimed at hospitality and service businesses.

## What is in this repository now

- Premium Veyra AI landing page and sample hotel chat.
- Express backend (server.js) with a live AI chat endpoint.
- OpenAI API key stays on the server in an environment variable.
- Business-specific FAQ/context injected into the AI system prompt.
- Basic request validation and API rate limiting.
- Conservative escalation rules for sensitive or uncertain requests.
- Optional Slack-compatible incoming-webhook alerts for staff handoffs.
- Explicit delivery status: notified, delivery failed, or not connected.
- Security headers, bounded request/history sizes, API timeout, and restricted public routes.
- Built-in Node test suite (`npm test`) with GitHub Actions CI.
- Opt-in live-model evaluation (`npm run test:live`) using fictional hotel facts and synthetic questions.
- Demo responses when the live backend is not configured.

## Important: prototype, not production SaaS

This is **not yet a complete €5,000/month enterprise product**. It does not yet include:
- Customer accounts, organization isolation, or a secure multi-tenant database.
- Native staff email/SMS/WhatsApp integrations (only a generic optional webhook is available).
- Booking, CRM, hotel PMS, Shopify, or payment integrations.
- A secure business-owner dashboard for editing FAQs.
- Billing, subscription management, audit logs, or enterprise SLAs.
- Production monitoring, executed CI test results, or independent security review.

Do not promise those features to customers until they are implemented and tested. Pricing needs to be justified by proven business value, reliability, support, and integrations—not by the number of AI features listed.

## Deploy a prototype on Render

This repository includes a Render Blueprint in `render.yaml`.

1. A parent/guardian should help create or manage any hosting and AI-provider accounts, review billing, and approve API usage.
2. Open Render and choose **New → Blueprint** (or connect the GitHub repository and create a Blueprint).
3. Select this repository and review the service settings in `render.yaml`.
4. In the Render service's Environment settings, add `OPENAI_API_KEY` as a secret. Never paste it into GitHub, website JavaScript, chat messages, or screenshots.
5. Optionally set `HANDOFF_WEBHOOK_URL` to a private, business-approved Slack-compatible incoming webhook. Staff alerts exclude the guest's message by default. Enable message forwarding only after explicit owner approval and a privacy review. Test delivery with a non-sensitive message.
6. Add the real business's approved FAQ and business name only after receiving permission.
7. Deploy, then open the service's `/api/health` endpoint and test the chat with non-sensitive sample questions.

Render's free web services may sleep after inactivity and take time to wake up. AI-provider usage may still cost money. A free hosting tier does not mean unlimited or free AI requests. Review current hosting and API prices before enabling customer traffic.

This is a **single-business prototype**, not a multi-company SaaS. Do not connect real customer data or promise service-level guarantees until authentication, tenant isolation, privacy controls, monitoring, and a security review are implemented.

## Health and readiness

- `GET /api/health` checks whether the process is responding and reports whether live AI configuration is present. A `degraded` status means the process is up but not ready to answer guests.
- `GET /api/ready` returns HTTP 200 only when an AI client and approved business knowledge are configured; otherwise it returns HTTP 503. This is a configuration check, not a proof that the provider is reachable or that answers are accurate.

## Run tests

Run `npm test` with Node.js 20 or newer. GitHub Actions runs this suite on pushes and pull requests. It covers backend routes, the OpenAI SDK request path using a controlled fake transport, prompt-injection handling, response schema validation, handoff delivery outcomes, frontend script parsing, rate limiting, and blocked access to private source/configuration files.

For a separate real-model check, run `npm run test:live` only after a parent/guardian has approved the API account and any usage charges, and after setting `OPENAI_API_KEY`. This sends ten synthetic questions about a fictional hotel through the live model. It does not use real guest data, is not run automatically in CI, and may incur API charges. A passing live evaluation is still not proof of production readiness.

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

- HANDOFF_WEBHOOK_URL: optional private Slack-compatible incoming webhook for staff alerts. It receives a handoff reason by default, not the guest's message. Guest message forwarding is disabled by default; only enable HANDOFF_INCLUDE_MESSAGE=true after explicit business-owner approval and a privacy review.
- HANDOFF_INCLUDE_MESSAGE: optional privacy-sensitive switch; defaults to false.
- OPENAI_API_KEY: server-side secret; required for live AI.
- OPENAI_MODEL: model name, default gpt-4.1-mini.
- PORT: server port, default 3000.
- BUSINESS_NAME: business name used by the assistant.
- BUSINESS_FAQ: approved facts and policies for the business.

## Next engineering milestones

1. Build authentication and strict tenant separation before serving multiple companies.
2. Store each company's knowledge base securely and add owner-approved updates.
3. Add reliable human handoff notifications and staff response tracking.
4. Add source-grounded answers, confidence checks, and evaluation tests.
5. Integrate one real business channel at a time (website widget first).
6. Add usage monitoring, privacy controls, data retention, and billing only after the core service is reliable.
7. Run security and reliability reviews before handling real customer data.

## Safety and reliability principles

- Never invent prices, room availability, booking confirmations, refund decisions, or business policies.
- Escalate uncertain, urgent, sensitive, or complaint-related requests to staff.
- Do not put API keys in frontend JavaScript or public GitHub files.
- Use only customer information that the business has permission to provide.
- Keep a human responsible for consequential decisions.
