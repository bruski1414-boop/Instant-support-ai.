# Veyra AI — Customer Support MVP

Veyra AI is an early customer-support assistant prototype aimed at hospitality and service businesses.

## What is in this repository now

- Premium Veyra AI landing page and sample hotel chat.
- Express backend (server.js) with a live AI chat endpoint.
- OpenAI API key stays on the server in an environment variable.
- Business-specific FAQ/context injected into the AI system prompt.
- Basic request validation and API rate limiting.
- Escalation flag for requests that should be reviewed by staff.
- Demo responses when the live backend is not configured.

## Important: prototype, not production SaaS

This is **not yet a complete €5,000/month enterprise product**. It does not yet include:
- Customer accounts, organization isolation, or a secure multi-tenant database.
- Real staff email/SMS/WhatsApp notifications.
- Booking, CRM, hotel PMS, Shopify, or payment integrations.
- A secure business-owner dashboard for editing FAQs.
- Billing, subscription management, audit logs, or enterprise SLAs.
- Production monitoring, automated tests, or independent security review.

Do not promise those features to customers until they are implemented and tested. Pricing needs to be justified by proven business value, reliability, support, and integrations—not by the number of AI features listed.

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

- OPENAI_API_KEY: server-side secret; required for live AI.
- OPENAI_MODEL: model name, default gpt-4.1-mini.
- PORT: server port, default 3000.
- ALLOWED_ORIGINS: comma-separated origins allowed to call the API. Defaults to localhost only.
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
