"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPaymentPostgresRepository } = require("../payment-postgres-repository");

function makePool() {
  const intent = {
    id: "intent-1", organization_id: "hotel-1", status: "awaiting_payment",
    payment_provider: "test-pay", payment_reference: "checkout-1",
    deposit_amount_minor: "50000", currency: "EUR",
    expires_at: new Date(Date.now() + 300000),
    idempotency_key: "key-1", checkout_url: "https://pay.example/1",
    checkout_expires_at: new Date(Date.now() + 180000),
  };
  const events = new Set();
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT id,organization_id,status,payment_provider")) {
        return { rowCount: intent.id === params[0] ? 1 : 0, rows: intent.id === params[0] ? [{ ...intent }] : [] };
      }
      if (sql.includes("INSERT INTO payment_provider_events")) {
        const key = params[0] + ":" + params[1];
        if (events.has(key)) return { rowCount: 0, rows: [] };
        events.add(key);
        return { rowCount: 1, rows: [{ id: "event-row" }] };
      }
      if (sql.includes("UPDATE booking_intents SET status='deposit_paid'")) {
        intent.status = "deposit_paid";
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE booking_intents SET status='requires_manual_review'")) {
        intent.status = "requires_manual_review";
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE booking_intents SET status='failed'")) {
        intent.status = "failed";
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() { statements.push({ released: true }); },
  };
  const pool = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql.includes("FROM booking_intents") && sql.includes("organization_id=$1")) {
        const found = intent.id === params[1] && intent.organization_id === params[0];
        return { rowCount: found ? 1 : 0, rows: found ? [{ ...intent }] : [] };
      }
      if (sql.includes("UPDATE booking_intents") && sql.includes("RETURNING id")) {
        const allowed = intent.id === params[1] && intent.organization_id === params[0] &&
          intent.status === "awaiting_payment" &&
          (!intent.payment_provider || intent.payment_provider === params[2]) &&
          (!intent.payment_reference || intent.payment_reference === params[3]);
        if (allowed) {
          Object.assign(intent, { payment_provider: params[2], payment_reference: params[3], checkout_url: params[4], checkout_expires_at: params[5] });
          return { rowCount: 1, rows: [{ id: intent.id }] };
        }
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    async connect() { return client; },
    state: intent,
    statements,
  };
  return pool;
}

function event(overrides = {}) {
  return {
    signatureVerified: true, eventId: "evt-1", eventType: "payment.succeeded",
    paymentStatus: "succeeded", providerReference: "checkout-1",
    bookingIntentId: "intent-1", amountMinor: 50000, currency: "EUR",
    ...overrides,
  };
}

test("booking lookup is scoped to the owning hotel", async () => {
  const pool = makePool();
  const repository = createPaymentPostgresRepository({ pool });
  assert.equal((await repository.getBookingIntent({ organizationId: "hotel-1", bookingIntentId: "intent-1" })).id, "intent-1");
  assert.equal(await repository.getBookingIntent({ organizationId: "other-hotel", bookingIntentId: "intent-1" }), null);
});

test("checkout is saved only against the matching live deposit and is safely reusable", async () => {
  const pool = makePool();
  const repository = createPaymentPostgresRepository({ pool });
  const input = {
    organizationId: "hotel-1", bookingIntentId: "intent-1", provider: "test-pay",
    providerReference: "checkout-1", checkoutUrl: "https://pay.example/1",
    checkoutExpiresAt: new Date(Date.now() + 120000),
    expectedAmountMinor: 50000, expectedCurrency: "EUR",
  };
  assert.equal((await repository.saveCheckout(input)).saved, true);
  await assert.rejects(repository.saveCheckout({ ...input, providerReference: "different" }), e => e.code === "CHECKOUT_STATE_CONFLICT");
});

test("verified successful deposit is atomically recorded and moves intent to deposit_paid", async () => {
  const pool = makePool();
  const repository = createPaymentPostgresRepository({ pool });
  const result = await repository.applyVerifiedPaymentEvent({ provider: "test-pay", event: event() });
  assert.equal(result.status, "recorded");
  assert.equal(pool.state.status, "deposit_paid");
  assert.ok(pool.statements.some(x => x.sql === "BEGIN"));
  assert.ok(pool.statements.some(x => x.sql === "COMMIT"));
  assert.ok(pool.statements.some(x => x.released));
});

test("duplicate provider event is not applied twice", async () => {
  const pool = makePool();
  const repository = createPaymentPostgresRepository({ pool });
  assert.equal((await repository.applyVerifiedPaymentEvent({ provider: "test-pay", event: event() })).status, "recorded");
  assert.equal((await repository.applyVerifiedPaymentEvent({ provider: "test-pay", event: event() })).status, "duplicate");
});

test("amount, currency, provider or reference mismatch requires manual review", async () => {
  for (const changed of [
    { amountMinor: 49999 }, { currency: "USD" }, { providerReference: "wrong-ref" },
  ]) {
    const pool = makePool();
    const repository = createPaymentPostgresRepository({ pool });
    const result = await repository.applyVerifiedPaymentEvent({ provider: "test-pay", event: event(changed) });
    assert.equal(result.status, "manual_review");
    assert.equal(pool.state.status, "requires_manual_review");
  }
});

test("unverified or malformed events are rejected before database writes", async () => {
  const pool = makePool();
  const repository = createPaymentPostgresRepository({ pool });
  await assert.rejects(repository.applyVerifiedPaymentEvent({ provider: "test-pay", event: event({ signatureVerified: false }) }), e => e.code === "INVALID_VERIFIED_EVENT");
  assert.equal(pool.statements.length, 0);
});
