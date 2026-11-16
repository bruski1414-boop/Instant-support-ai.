"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBookingAttributionStore } = require("../booking-attribution-store");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

function createMemoryPool() {
  const state = {
    conversations: new Set([ORG + ":" + CONVERSATION]),
    intents: [],
    matches: [],
    audits: [],
    statements: [],
    failMatchInsert: false
  };
  let nextId = 1;
  const client = {
    async query(sql, params = []) {
      const statement = sql.trim().replace(/\\s+/g, " ");
      state.statements.push(statement);
      if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (statement.startsWith("SELECT id FROM conversations")) {
        const found = state.conversations.has(params[1] + ":" + params[0]);
        return { rowCount: found ? 1 : 0, rows: found ? [{ id: params[0] }] : [] };
      }
      if (statement.startsWith("INSERT INTO booking_attribution_intents")) {
        const row = { id: "intent-" + nextId++, organization_id: params[0], conversation_id: params[1], token_hash: params[2], issued_at: params[3], expires_at: params[4], consumed_at: null, provider: null, provider_event_id: null, reservation_id: null };
        state.intents.push(row);
        return { rowCount: 1, rows: [{ id: row.id }] };
      }
      if (statement.startsWith("SELECT id,organization_id,conversation_id,token_hash,issued_at,expires_at,consumed_at,provider,provider_event_id,reservation_id FROM booking_attribution_intents")) {
        const row = state.intents.find(x => x.organization_id === params[0] && x.token_hash === params[1]);
        return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
      }
      if (statement.startsWith("INSERT INTO booking_attribution_matches")) {
        if (state.failMatchInsert) { const error = new Error("simulated insert failure"); error.code = "XX000"; throw error; }
        const [organization_id,intent_id,conversation_id,provider,provider_event_id,reservation_id,occurred_at,booking_value_minor,currency,match_method] = params;
        if (state.matches.some(x => x.intent_id === intent_id || (x.organization_id === organization_id && x.provider === provider && (x.provider_event_id === provider_event_id || x.reservation_id === reservation_id)))) {
          const error = new Error("unique constraint"); error.code = "23505"; throw error;
        }
        const row = { id: "match-" + nextId++, organization_id,intent_id,conversation_id,provider,provider_event_id,reservation_id,occurred_at,booking_value_minor,currency,match_method };
        state.matches.push(row);
        return { rowCount: 1, rows: [{ id: row.id }] };
      }
      if (statement.startsWith("UPDATE booking_attribution_intents SET consumed_at")) {
        const row = state.intents.find(x => x.id === params[0] && x.organization_id === params[1] && x.consumed_at === null);
        if (!row) return { rowCount: 0, rows: [] };
        Object.assign(row, { consumed_at: params[2], provider: params[3], provider_event_id: params[4], reservation_id: params[5] });
        return { rowCount: 1, rows: [] };
      }
      if (statement.startsWith("INSERT INTO audit_logs")) {
        state.audits.push({ action: params[2], target_id: params[3] });
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected SQL in memory test pool: " + statement);
    },
    release() { state.releases = (state.releases || 0) + 1; }
  };
  return { state, pool: { async connect() { return client; } } };
}

function reservationEvent(token, overrides = {}) {
  return {
    eventId: "provider-event-001",
    eventType: "reservation.created",
    occurredAt: "2026-11-15T10:01:00.000Z",
    reservationId: "reservation-001",
    status: "confirmed",
    arrivalDate: "2026-12-01",
    departureDate: "2026-12-04",
    attributionToken: token,
    totalAmountMinor: 84000,
    currency: "EUR",
    guestEmail: "must-be-discarded@example.invalid",
    ...overrides
  };
}

test("issues a token for a conversation in the same tenant and persists only its hash", async () => {
  const { state, pool } = createMemoryPool();
  const store = createBookingAttributionStore({ pool });
  const issued = await store.issueIntent({ organizationId: ORG, conversationId: CONVERSATION, issuedAt: "2026-11-15T10:00:00.000Z" });
  assert.ok(issued.oneTimeToken);
  assert.equal(state.intents.length, 1);
  assert.equal(state.intents[0].token_hash.length, 64);
  assert.equal(JSON.stringify(state.intents[0]).includes(issued.oneTimeToken), false);
  assert.equal(state.audits[0].action, "booking_attribution.intent_issued");
  assert.equal(state.releases, 1);
});

test("refuses to issue an intent for a conversation in another tenant", async () => {
  const { state, pool } = createMemoryPool();
  const store = createBookingAttributionStore({ pool });
  await assert.rejects(store.issueIntent({ organizationId: OTHER_ORG, conversationId: CONVERSATION }), /Conversation not found/);
  assert.equal(state.intents.length, 0);
  assert.equal(state.audits.length, 0);
  assert.ok(state.statements.includes("ROLLBACK"));
});

test("persists a confirmed token-matched booking once with an audit record", async () => {
  const { state, pool } = createMemoryPool();
  const store = createBookingAttributionStore({ pool });
  const issued = await store.issueIntent({ organizationId: ORG, conversationId: CONVERSATION, issuedAt: "2026-11-15T10:00:00.000Z" });
  const result = await store.consumeConfirmedReservation({ organizationId: ORG, provider: "trusted-pms-adapter", reservationEvent: reservationEvent(issued.oneTimeToken) });
  assert.equal(result.status, "matched");
  assert.equal(result.match.conversationId, CONVERSATION);
  assert.deepEqual(result.match.bookingValue, { amountMinor: 84000, currency: "EUR" });
  assert.equal(state.matches.length, 1);
  assert.equal(state.intents[0].consumed_at, "2026-11-15T10:01:00.000Z");
  assert.equal(state.audits.at(-1).action, "booking_attribution.reservation_matched");
  assert.equal(JSON.stringify(result).includes("must-be-discarded"), false);
});

test("replayed provider event is idempotent and does not create a second match", async () => {
  const { state, pool } = createMemoryPool();
  const store = createBookingAttributionStore({ pool });
  const issued = await store.issueIntent({ organizationId: ORG, conversationId: CONVERSATION, issuedAt: "2026-11-15T10:00:00.000Z" });
  const event = reservationEvent(issued.oneTimeToken);
  assert.equal((await store.consumeConfirmedReservation({ organizationId: ORG, provider: "trusted-pms-adapter", reservationEvent: event })).status, "matched");
  assert.equal((await store.consumeConfirmedReservation({ organizationId: ORG, provider: "trusted-pms-adapter", reservationEvent: event })).status, "duplicate");
  assert.equal(state.matches.length, 1);
  assert.equal(state.audits.filter(x => x.action === "booking_attribution.reservation_matched").length, 1);
});

test("wrong-tenant token, wrong token and unconfirmed reservation never match", async () => {
  const { state, pool } = createMemoryPool();
  const store = createBookingAttributionStore({ pool });
  const issued = await store.issueIntent({ organizationId: ORG, conversationId: CONVERSATION, issuedAt: "2026-11-15T10:00:00.000Z" });
  assert.equal((await store.consumeConfirmedReservation({ organizationId: OTHER_ORG, provider: "trusted-pms-adapter", reservationEvent: reservationEvent(issued.oneTimeToken) })).status, "unmatched");
  assert.equal((await store.consumeConfirmedReservation({ organizationId: ORG, provider: "trusted-pms-adapter", reservationEvent: reservationEvent("B".repeat(43)) })).status, "unmatched");
  assert.equal((await store.consumeConfirmedReservation({ organizationId: ORG, provider: "trusted-pms-adapter", reservationEvent: reservationEvent(issued.oneTimeToken, { status: "pending" }) })).status, "unmatched");
  assert.equal(state.matches.length, 0);
});

test("failed match persistence rolls back and leaves the intent unconsumed", async () => {
  const { state, pool } = createMemoryPool();
  const store = createBookingAttributionStore({ pool });
  const issued = await store.issueIntent({ organizationId: ORG, conversationId: CONVERSATION, issuedAt: "2026-11-15T10:00:00.000Z" });
  state.failMatchInsert = true;
  await assert.rejects(store.consumeConfirmedReservation({ organizationId: ORG, provider: "trusted-pms-adapter", reservationEvent: reservationEvent(issued.oneTimeToken) }), /simulated insert failure/);
  assert.equal(state.intents[0].consumed_at, null);
  assert.ok(state.statements.includes("ROLLBACK"));
});
