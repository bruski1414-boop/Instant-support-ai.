# Veyra AI — supervised hotel pilot runbook

**Status: NOT APPROVED FOR HOTEL GUEST TRAFFIC.** This runbook is a controlled path from the current development demo to a supervised, limited pilot. Completing the automated CI suite is necessary but not sufficient.

A parent/guardian or authorised adult operator must own the hosting, database, AI-provider account, billing, legal agreements, incident response, and security review. Do not place real guest data in this system until every applicable gate below is signed off.

## 1. Current verified baseline

- Development branch: `build/veyra-real-demo`.
- CI run #358 passed on commit `b0f0affa5c8d97663b25a286ab2cc54339166805`.
- CI exercised the Node test suite, Chromium guest/dashboard checks, five PostgreSQL migrations, restricted-role tenant-isolation checks, and authentication/session integration tests using synthetic data and disposable infrastructure.
- No live hosted PostgreSQL database, production secrets, real hotel, or paying pilot is connected.
- The live-model evaluation has not been run.
- The existing Render prototype deploys `main`, not this development branch. Do not treat that service as a pilot deployment.

## 2. Product limits that must be disclosed

The current build is a website guest-chat and staff-review queue prototype. It does **not** provide:
- PMS, booking, reservation, room-inventory, payment, refund, CRM, or billing actions;
- outbound guest replies from staff; staff messages in the dashboard are internal notes, not messages delivered to the guest;
- email, SMS, WhatsApp, push notifications, or a guaranteed staff alert channel (Slack incoming webhooks are optional and must be tested);
- scheduled retention deletion, a guest-data export workflow, or a complete privacy-request workflow;
- an enterprise SLA, 24/7 staffed support, or independently audited security certification.

Never market or configure it as if these functions exist. For a first pilot, restrict it to approved FAQ information and clearly explain that bookings, rates, availability, payments, cancellations, refunds, allergies, complaints, safety issues, and other sensitive requests go to hotel staff.

## 3. Gate A — adult/operator approval

Before provisioning anything:
- [ ] An adult operator is named as the accountable service operator.
- [ ] Hotel owner/manager gives written permission for a pilot and approves the exact knowledge content, website domain, staff recipients, and support hours.
- [ ] A qualified reviewer checks privacy notices, lawful basis/consent where applicable, data-processing terms, cross-border hosting, retention, deletion, and incident-notification duties for the hotel's jurisdiction and guests.
- [ ] The hotel agrees who monitors the handoff queue, during which hours, and what guests should do outside those hours.
- [ ] Hosting and AI-provider costs, usage limits, and a monthly spend cap are approved by the adult account owner.
- [ ] No production credentials are shared in chat, GitHub issues, source files, screenshots, or browser-visible code.

**Stop if any item is unresolved.**

## 4. Gate B — isolated staging infrastructure

Use a new isolated staging environment; do not repoint or overwrite the existing prototype service.

- [ ] Provision a private hosted PostgreSQL database in a region approved by the hotel and its privacy reviewer.
- [ ] Create a separate database-owner/migration role and a separate least-privilege application runtime login. The web service must never use the owner connection string.
- [ ] Require verified TLS for database connections.
- [ ] Apply migrations 001 through 005 in order using the authorised migration role.
- [ ] Configure `DATABASE_URL`, `DATABASE_SSL=true`, `APP_ORIGIN` (exact HTTPS origin), `NODE_ENV=production`, `OPENAI_API_KEY`, `OPENAI_MODEL`, and a randomly generated 32-byte base64 `TENANT_INTEGRATION_ENCRYPTION_KEY` as hosting-provider secrets. Never commit or paste secret values.
- [ ] Keep `HANDOFF_INCLUDE_MESSAGE=false`; do not forward guest message contents to Slack during the first pilot.
- [ ] Use an adult-controlled, approved AI-provider account with a strict spend limit.
- [ ] Deploy only the reviewed development commit to staging, not the current public prototype.
- [ ] Run `npm run preflight:production` from an authorised trusted environment. Save the non-secret output for review.
- [ ] Confirm `/api/health` and `/api/ready` behave as expected; readiness must fail closed when a required dependency is missing.
- [ ] Provision the first owner account from a trusted terminal using the separate privileged connection and `npm run provision:owner`. Never use a default password.
- [ ] Confirm that the owner can sign in, sign out, and only see their own workspace.

Do not add real guest information during this gate.

## 5. Gate C — staging acceptance tests

Use only fictional or synthetic data. Record timestamp, build commit, test case, expected result, actual result, and pass/fail.

### Guest answers
- [ ] Every approved fact in the hotel's test pack is answered correctly.
- [ ] Unknown facts (Wi-Fi credentials, rates, inventory, pet/parking policies, menu details, and any omitted policy) are not guessed.
- [ ] Booking, room availability, reservation changes, cancellation, refunds, payment, and other transactions are never claimed as completed.
- [ ] Allergy, medical, accessibility, safety, emergency, complaint, harassment, privacy, and other sensitive cases are routed to staff with safe wording.
- [ ] Prompt-injection attempts do not override approved knowledge or reveal secrets.
- [ ] Responses remain clear about the assistant's limits and never claim a staff member has been contacted unless delivery has been independently confirmed.

### Handoff and staff operations
- [ ] A synthetic escalated conversation appears in the authenticated handoff inbox.
- [ ] The designated staff member can locate and review it.
- [ ] Slack alert delivery is tested in a hotel-approved test channel, if Slack is enabled.
- [ ] A failed or unconfigured alert is visibly treated as a failure, not a successful notification.
- [ ] Staff understand dashboard messages are internal notes and are not sent to guests.
- [ ] A human process exists to contact the guest using the hotel's existing approved channel.

### Security and data handling
- [ ] Cross-tenant access attempts fail for every relevant route.
- [ ] Non-members, disabled users, expired sessions, revoked sessions, and invalid CSRF requests are rejected.
- [ ] The runtime database role is not superuser, table owner, BYPASSRLS, CREATEDB, or CREATEROLE.
- [ ] No secrets appear in browser responses, application logs, CI output, or repository history.
- [ ] Website launcher works only for the hotel-approved HTTPS origin.
- [ ] Rate limits and request-size limits behave as expected.
- [ ] Backup restore is tested into a separate database and the result is documented.
- [ ] Retention and permanent-deletion behavior are reviewed; note that automatic retention purge currently runs on workspace access, not on a schedule.
- [ ] Monitoring and an adult-owned incident contact are in place.

### Live-model evaluation
- [ ] An adult account owner explicitly approves the AI-provider account and spend before `npm run test:live` is run.
- [ ] Run the 15 synthetic Northstar Hotel scenarios and record the full result.
- [ ] Investigate every failure. Do not lower thresholds or weaken safety checks just to obtain a pass.
- [ ] Repeat the evaluation after every prompt/model/knowledge change.

A passing 15-case evaluation is only a smoke test, not proof of answer accuracy or security.

## 6. Gate D — limited supervised pilot

Only after Gates A–C are signed off:
- [ ] Start with one hotel, one approved website origin, a small approved FAQ, and a small group of staff.
- [ ] Keep the pilot opt-in and clearly disclose that the chat is AI-assisted.
- [ ] Keep a visible route to the hotel's normal reception/support channel.
- [ ] Do not collect payment details, identity documents, health details, or other sensitive information in chat.
- [ ] Have a named staff member monitor every handoff during agreed hours.
- [ ] Review transcripts and failures daily under the hotel's approved privacy process.
- [ ] Keep a documented rollback switch: disable the website launcher and public chat, then return guests to the hotel's existing support channel.
- [ ] Do not claim revenue uplift, reduced staffing, or service-level performance until measured against a baseline.

Suggested pilot success criteria (agree these with the hotel before launch):
- 100% correct answers across the approved factual test set;
- zero invented rates, availability, policies, booking changes, refunds, or completed actions;
- 100% of critical/sensitive test cases correctly escalated;
- every handoff visible to staff, with no false claim that staff were notified;
- no cross-tenant or unauthorised access in the security test;
- documented human coverage and a successful rollback exercise.

Any fabricated critical answer, missed critical escalation, data leak, unexplained outage, or unmonitored handoff is a **stop-pilot event**. Disable guest traffic, preserve relevant non-sensitive logs, notify the adult operator and hotel contact, investigate, and do not resume until reviewed.

## 7. Gate E — independent sign-off

Before any expansion or paying production contract:
- [ ] Independent security review of application code, database policies, deployment configuration, and secrets handling.
- [ ] Privacy/legal review and hotel-approved data-processing terms.
- [ ] Backup, restore, retention, deletion, incident-response, and monitoring evidence reviewed.
- [ ] Pilot results and limitations reviewed with the hotel.
- [ ] Support ownership, response times, escalation coverage, and service availability terms agreed in writing.
- [ ] Feature and pricing claims match what is actually implemented and measured.

**Go-live decision:** an authorised adult/operator and the hotel owner/manager must jointly record approval. CI green alone is never a go-live approval.
