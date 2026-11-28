# Guest-confirmed resolution evidence

Status: implemented as an explicit guest action, tenant-scoped event record, aggregate report and dashboard section on `feature/guest-confirmed-resolution-evidence-v1`. Synthetic CI integration is required before considering the feature validated. No live hotel data is included.

## What the guest action means

After a non-handoff assistant reply, the widget offers an optional **“My question is resolved”** action. It is separate from a helpfulness rating. The guest can ignore it and continue chatting.

The action records only that the guest explicitly said the latest assistant response resolved their question at that moment. It does not prove factual correctness, satisfaction, causation or financial value.

## Acceptance rules

The public endpoint requires:
- The server-issued conversation UUID.
- The server-issued guest token; only its SHA-256 hash is stored on the conversation.
- The exact assistant-message UUID returned by the chat endpoint.
- A non-suspended hotel resolved from the URL slug; the browser cannot supply an authoritative organization ID.

The endpoint locks the tenant-scoped conversation row in a transaction. It accepts a new confirmation only when:
- The token hash matches that conversation and hotel.
- The referenced message is an assistant message in that conversation.
- It is the latest message (ties fail closed).
- No staff message exists in the conversation.
- No escalation record exists for the conversation.

A later guest message does not erase the append-only confirmation record, but it makes the earlier confirmation ineligible as a current self-service candidate in subsequent reports. This prevents a resolved old answer from being treated as the final outcome after the guest asks something else.

Exact retries for the same assistant message are idempotent and return the existing event. Conflicting or cross-tenant references are rejected.

## Storage, audit and retention

The `conversation_resolution_confirmations` table stores only:
- Event UUID.
- Organization UUID.
- Conversation UUID.
- Assistant-message UUID.
- Confirmation timestamp.

It does not store guest names, email addresses, phone numbers, transcripts, message content or the plaintext guest token.

Composite foreign keys bind the event to the same tenant conversation and assistant message. A database trigger rejects non-assistant message references. Direct updates/deletes are rejected; parent conversation/organization retention cascades remain possible. The event insert and a corresponding audit-log entry commit in one transaction.

## Report definitions

The owner/staff performance report uses a rolling 720-hour UTC window with inclusive start and exclusive end, based on `confirmed_at`.

- **Guest-reported conversations:** distinct conversations with at least one explicit guest confirmation in the window.
- **Self-service candidates:** a subset with exactly one confirmation ever, no staff message, no escalation, and no later message after the confirmation.
- **Assisted or ambiguous:** guest-reported conversations that do not meet all self-service candidate conditions.
- **Influenced conversations:** not measured.
- **Potential staff minutes avoided:** not calculated. The hotel-specific historical active-handling-time baseline and the PR #40 estimator are not connected to this event store.

Counts are aggregate only; no guest or conversation identifiers are returned.

## Limitations and next gates

- Guest confirmation is self-reported and does not establish semantic correctness.
- Absence of a staff message/escalation is evidence only within Veyra's recorded channels; off-platform staff activity may be invisible.
- The self-service candidate count is not actual saved time, labour cost, cash savings, incremental revenue or proof Veyra caused the outcome.
- No feedback-prompt impression denominator is recorded, so no feedback rate is calculated.
- The current feature does not automatically merge the separate guest-helpfulness feedback PR or the PR #40 staff-time baseline estimator.
- A later integration must consume the event only after verifying the full conversation chain and must invalidate it if subsequent messages arrive.

Do not claim measured staff savings or a €2,000/month return until an authorised hotel pilot supplies reviewed historical handling-time data and independent operational checks. No merge, deployment, live provider connection or real guest-data access is part of this PR.
