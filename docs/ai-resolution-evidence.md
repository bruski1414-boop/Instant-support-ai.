# AI resolution evidence — implementation specification

Status: implemented on `feature/ai-resolution-evidence`; automated unit and tenant-isolation tests passed on the earlier feedback implementation. The latest AI evidence-guard changes require a fresh CI run. Production verification remains outstanding.

## Why this is needed

The current product records assistant messages and staff escalations, but a non-escalated conversation is not proof that the guest's question was answered. The existing `open` conversation state must never be counted as an AI resolution.

## Guest feedback flow

After an assistant reply that does not require staff, show two optional actions in the guest widget:

- **That answered my question**
- **I still need help**

Do not interrupt the guest or require feedback to continue chatting. If the guest sends another message, keep the conversation open and do not treat earlier feedback as final for the whole conversation.

The feedback endpoint must require the server-issued conversation ID and guest token. Validate the token by comparing its hash with `conversations.guest_token_hash`; never accept an organization ID supplied by the browser as authority. Resolve the conversation's organization from the database.

## Evidence model

The current feature branch adds an append-only `conversation_resolution_feedback` table and a public endpoint. The endpoint validates the hotel slug, guest token hash, conversation ownership, and assistant-message role. It rejects duplicate feedback. `needs_help` creates or reuses an escalation and attempts the existing notification flow. The chat response now returns the assistant message ID, and the widget renders the two optional buttons for non-handoff assistant replies. The feedback implementation passed the earlier unit and PostgreSQL tenant-isolation CI run. The later AI evidence-guard changes are awaiting their own fresh CI result.

The table records:

- `id` UUID primary key
- `organization_id` UUID, foreign key to organizations
- `conversation_id` UUID, foreign key to conversations
- `assistant_message_id` UUID, foreign key to messages
- `feedback` constrained to `helpful` or `needs_help`
- `created_at` timestamp

Add a unique constraint on `assistant_message_id` so one assistant reply cannot be counted repeatedly. Ensure the assistant message belongs to the same conversation and organization before inserting. Cascading deletion should follow the conversation's retention/deletion lifecycle.

For `needs_help`, create or reuse a staff escalation in the same transaction, then attempt the configured notification using the existing notification flow. The guest-facing response must clearly say if staff notification is not confirmed and provide the hotel's normal contact route. Do not claim a handoff was delivered unless the receiver accepted it.

## Metric definitions

Report separate counts for the rolling 30-day period:

1. **AI helpful confirmations:** distinct conversations with guest feedback `helpful`.
2. **Guest-reported need for help:** distinct conversations with feedback `needs_help`.
3. **Staff handoffs:** distinct conversations with an escalation created in the period.
4. **Staff-resolved conversations:** distinct conversations with an escalation resolved by authorised staff.
5. **Unclassified conversations:** conversations with assistant replies but no guest feedback and no staff resolution.

A provisional feedback rate may be shown as helpful confirmations divided by all conversations that received the feedback prompt, but only after a prompt-impression event is implemented. Until then, show raw counts and explicitly label the denominator unavailable.

Never infer AI resolution from absence of an escalation, a closed browser window, message count, or the conversation's `open` status. Never present guest-reported helpfulness as independently verified correctness.

## Dashboard wording

Use labels such as:

- Guest-confirmed helpful
- Guest requested more help
- Staff handoffs
- Staff-resolved handoffs
- Outcome not confirmed

Add a visible note: "Guest feedback is self-reported and does not independently verify answer accuracy. Conversations without feedback are unclassified, not successful."

## Required tests

- Valid conversation token can submit feedback only for its own conversation.
- Missing, malformed, or wrong token is rejected.
- Cross-tenant and cross-conversation attempts are rejected.
- Only an assistant message in that conversation can be rated.
- Duplicate feedback for the same assistant reply is rejected or safely idempotent.
- `needs_help` creates/reuses one escalation and never silently claims notification delivery.
- Feedback and aggregate metrics are tenant-scoped.
- Conversation deletion removes feedback through cascading deletion.
- No-feedback conversations remain unclassified and are never counted as AI-resolved.
- Dashboard labels and denominators match the definitions above.

## Remaining implementation work

- Add automated unit/integration coverage for token validation, cross-tenant isolation, duplicate submissions, escalation creation/reuse, notification outcomes, and retention deletion.
- Review the tenant-scoped dashboard counts against seeded test data and confirm the labels render correctly.
- Treat the concrete-token evidence guard as a conservative heuristic only; it cannot prove semantic entailment for every natural-language claim. Use an approved human-reviewed evaluation set before a hotel pilot.
- Add a feedback-prompt impression event before calculating any feedback rate.
- Run the full test suite and integration suite against the exact feature commit; test notification delivery with a controlled endpoint.

## Release gates

Do not expose this as a hotel performance metric until the migration, API, widget, dashboard, tenant-isolation tests, retention behavior, and real notification test all pass on the same commit. Use synthetic data only until an authorised hotel approves its privacy notice and guest-data processing arrangements.


## Deterministic guest-support benchmark

A synthetic, mock-provider benchmark now lives in `tests/guest-support-benchmark.test.js`. It exercises:

- A supported answer with exact evidence.
- Abstention when a requested policy is absent.
- A real but unrelated quotation.
- A fabricated quotation.
- A sensitive allergy request.
- An immediate-danger report that must override the model response.

The benchmark uses fictional Aster House facts and mocked model responses. It does not call a live AI provider, incur model usage charges, or measure real model accuracy. Passing means the deterministic policy/validation path behaved as expected for these fixtures; it is not evidence of production answer quality. A separately human-reviewed dataset and controlled live-model evaluation are still required before a hotel pilot.


## 100-question synthetic hotel QA benchmark

The benchmark fixture is `tests/fixtures/guest-support-benchmark.js`, exercised by `tests/guest-support-benchmark.test.js`. It contains exactly 100 fictional Aster House scenarios:

- 40 supported-fact questions across 10 approved knowledge entries.
- 30 questions about information deliberately absent from the knowledge base; expected behaviour is abstention and staff follow-up.
- 30 sensitive or operational requests; expected behaviour is staff escalation, including threats, payment disputes and immediate-danger guidance for smoke, fire, gas leak, breathing difficulty, unconsciousness, or not breathing.

The test uses mocked model responses. It checks the deterministic application policy and evidence gate, not the intelligence or accuracy of a live model. It does not make model API calls. Passing this benchmark is a software regression signal only, not a claim of 100% answer accuracy or hotel readiness.

## Opt-in live-model evaluation runner

The script `scripts/evaluate-live-guest-support.js` runs the same fictional Aster House benchmark through the configured live model using the existing guest-support engine. It reports handoff-classification results by category and checks that immediate-danger scenarios include the configured emergency instruction.

The runner is deliberately blocked unless all of the following are supplied explicitly:

- `VEYRA_LIVE_EVAL_APPROVED=YES` after the API account owner has approved the test.
- `OPENAI_API_KEY` for the approved provider account.
- `VEYRA_AI_MODEL` naming the model to test.
- `VEYRA_LIVE_EVAL_LIMIT` as an explicit integer from 1 to 100, to limit request count and potential charges.
- Optional `OPENAI_BASE_URL` only when using an approved compatible provider endpoint.

Run it with `npm run evaluate:live`. Start with a very small limit, review provider pricing and usage limits first, and never put API keys in source code, browser code, commits, chat messages, or screenshots. A parent/guardian or the adult who owns the API account should approve and supervise any paid API use.

The runner uses synthetic hotel information only. Its automated score measures handoff classification and emergency wording; it does not prove that a free-form answer is semantically correct. Human review of every automatic answer against the approved source remains mandatory. Do not run this against a real hotel's private knowledge or guest records.

