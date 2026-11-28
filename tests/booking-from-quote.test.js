"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBookingRecordFromQuote } = require("../booking-repository");

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_QUOTE = "22222222-2222-4222-8222-222222222222";
const request = (overrides = {}) => ({
  quoteId: QUOTE_ID,
  idempotencyKey: "guest_booking_12345",
  guest: { name: "Alex Guest", phone: "+66812345678", email: "alex@example.test" },
  ...overrides,
});

function fixture({ quote = {}, tenant = "hotel-a" } = {}) {
  const state = {
    tenant,
    consumed: false,
    bookings: new Map(),
    calls: [],
    quote: {
      id: QUOTE_ID,
      room_type_id: "ocean-villa",
      check_in: "2027-03-10",
      check_out: "2027-03-12",
      guest_count: 2,
      currency: "THB",
      amount_minor: "250001",
      available_units: 1,
      ...quote,
    },
  };
  const client = {
    async query(sql, params = []) {
      state.calls.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.startsWith("SELECT pg_advisory_xact_lock")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("SELECT id,quote_id")) {
        const row = state.bookings.get(params[0] + ":" + params[1]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.startsWith("SELECT id,room_type_id")) {
        if (params[1] !== state.tenant || params[0] !== state.quote.id || state.consumed) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [state.quote] };
      }
      if (sql.startsWith("UPDATE hotel_availability_quotes")) {
        if (params[1] !== state.tenant || params[0] !== state.quote.id || state.consumed) return { rowCount: 0, rows: [] };
        state.consumed = true;
        return { rowCount: 1, rows: [{ id: state.quote.id }] };
      }
      if (sql.startsWith("INSERT INTO hotel_bookings")) {
        const row = {
          id: "booking-" + (state.bookings.size + 1),
          quote_id: params[1],
          guest_name: params[3],
          guest_phone: params[4],
          guest_email: params[5],
          state: "awaiting_payment",
          total_amount_minor: String(params[11]),
          deposit_amount_minor: String(params[12]),
        };
        state.bookings.set(params[0] + ":" + params[2], row);
        return { rowCount: 1, rows: [{ id: row.id, state: row.state }] };
      }
      throw new Error("Unexpected SQL: " + sql);
    },
    release() {},
  };
  return { state, db: { async connect() { return client; } } };
}

test("creates a booking from the saved quote and ignores client-supplied commercial fields", async () => {
  const f = fixture();
  const result = await createBookingRecordFromQuote(f.db, "hotel-a", request({
    roomTypeId: "attacker-room",
    checkIn: "2030-01-01",
    checkOut: "2030-01-02",
    guestCount: 19,
    currency: "USD",
    totalAmountMinor: 1,
  }));
  assert.equal(result.created, true);
  assert.equal(result.state, "awaiting_payment");
  assert.equal(result.currency, "THB");
  assert.equal(result.totalAmountMinor, 250001);
  assert.equal(result.depositAmountMinor, 125001);
  assert.equal(result.balanceAmountMinor, 125000);
  assert.equal(f.state.consumed, true);
  const insert = f.state.calls.find(x => x.sql.startsWith("INSERT INTO hotel_bookings"));
  assert.equal(insert.params[6], "2027-03-10");
  assert.equal(insert.params[7], "2027-03-12");
  assert.equal(insert.params[8], "ocean-villa");
  assert.equal(insert.params[9], 2);
  assert.equal(insert.params[10], "THB");
  assert.equal(insert.params[11], 250001);
});

test("scopes quote lookup to the hotel and rejects a quote from another tenant", async () => {
  const f = fixture();
  await assert.rejects(
    () => createBookingRecordFromQuote(f.db, "hotel-b", request()),
    error => error.code === "QUOTE_INVALID_OR_EXPIRED"
  );
  const lookup = f.state.calls.find(x => x.sql.startsWith("SELECT id,room_type_id"));
  assert.deepEqual(lookup.params, [QUOTE_ID, "hotel-b"]);
  assert.equal(f.state.consumed, false);
});

test("does not reuse expired, consumed or zero-availability quotes", async () => {
  for (const quote of [{ available_units: 0 }, { amount_minor: "0" }]) {
    const f = fixture({ quote });
    await assert.rejects(
      () => createBookingRecordFromQuote(f.db, "hotel-a", request()),
      error => error.code === "INVALID_STORED_QUOTE"
    );
    assert.equal(f.state.consumed, false);
  }
  const f = fixture();
  f.state.consumed = true;
  await assert.rejects(
    () => createBookingRecordFromQuote(f.db, "hotel-a", request()),
    error => error.code === "QUOTE_INVALID_OR_EXPIRED"
  );
});

test("same idempotency key and same quote returns existing booking without consuming twice", async () => {
  const f = fixture();
  const first = await createBookingRecordFromQuote(f.db, "hotel-a", request());
  const row = f.state.bookings.get("hotel-a:guest_booking_12345");
  const second = await createBookingRecordFromQuote(f.db, "hotel-a", request());
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.bookingId, row.id);
  assert.equal(f.state.calls.filter(x => x.sql.startsWith("UPDATE hotel_availability_quotes")).length, 1);
});

test("rejects reuse of an idempotency key for different guest or quote", async () => {
  const f = fixture();
  await createBookingRecordFromQuote(f.db, "hotel-a", request());
  await assert.rejects(
    () => createBookingRecordFromQuote(f.db, "hotel-a", request({ quoteId: OTHER_QUOTE })),
    error => error.code === "BOOKING_IDEMPOTENCY_COLLISION"
  );
  await assert.rejects(
    () => createBookingRecordFromQuote(f.db, "hotel-a", request({ guest: { name: "Other Guest", phone: "+66812345678" } })),
    error => error.code === "BOOKING_IDEMPOTENCY_COLLISION"
  );
});
