"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeBookingRecord,
  createBookingRecord,
  recordVerifiedDeposit,
} = require("../booking-repository");

function validInput(overrides = {}) {
  return {
    checkIn: "2027-03-10",
    checkOut: "2027-03-12",
    guest: { name: "Alex Guest", phone: "+66812345678", email: "alex@example.test" },
    roomTypeId: "ocean-villa",
    guestCount: 2,
    currency: "THB",
    totalAmountMinor: 250001,
    idempotencyKey: "booking_req_12345",
    ...overrides,
  };
}

function fakeDb() {
  const bookings = new Map();
  const byId = new Map();
  const events = new Map();
  let nextId = 1;
  const client = {
    async query(sql, p = []) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO hotel_bookings")) {
        const key = p[0] + ":" + p[1];
        if (bookings.has(key)) return { rowCount: 0, rows: [] };
        const row = {
          id: "booking-" + nextId++, organization_id: p[0], idempotency_key: p[1],
          guest_name: p[2], guest_phone: p[3], guest_email: p[4],
          check_in: p[5], check_out: p[6], room_type_id: p[7], guest_count: p[8],
          currency: p[9], total_amount_minor: String(p[10]), deposit_amount_minor: String(p[11]),
          balance_amount_minor: String(p[12]), state: "awaiting_payment",
        };
        bookings.set(key, row); byId.set(row.id, row);
        return { rowCount: 1, rows: [{ id: row.id, state: row.state }] };
      }
      if (sql.startsWith("SELECT id,guest_name")) {
        const row = bookings.get(p[0] + ":" + p[1]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.startsWith("INSERT INTO payment_webhook_events")) {
        const key = p[0] + ":" + p[1] + ":" + p[2];
        if (events.has(key)) return { rowCount: 0, rows: [] };
        events.set(key, { payload_sha256: p[3], status: "received" });
        return { rowCount: 1, rows: [{ id: "event-" + events.size }] };
      }
      if (sql.startsWith("SELECT payload_sha256")) {
        const event = events.get(p[0] + ":" + p[1] + ":" + p[2]);
        return { rowCount: event ? 1 : 0, rows: event ? [event] : [] };
      }
      if (sql.startsWith("SELECT id,state,deposit_amount_minor")) {
        const row = byId.get(p[0]);
        return { rowCount: row && row.organization_id === p[1] ? 1 : 0, rows: row && row.organization_id === p[1] ? [row] : [] };
      }
      if (sql.startsWith("SELECT id FROM hotel_bookings WHERE organization_id=$1 AND payment_provider")) {
        const row = byId.get(p[3]);
        return { rowCount: row && row.payment_provider === p[1] && row.payment_provider_payment_id === p[2] ? 1 : 0, rows: [] };
      }
      if (sql.startsWith("UPDATE hotel_bookings SET state='payment_verified'")) {
        const row = byId.get(p[0]);
        Object.assign(row, { state: "payment_verified", payment_provider: p[2], payment_provider_payment_id: p[3] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE payment_webhook_events SET status=")) return { rowCount: 1, rows: [] };
      throw new Error("Unexpected SQL in fake database: " + sql);
    },
    release() {},
  };
  return { bookings, events, async connect() { return client; } };
}

test("normalizes a booking and calculates the exact 50 percent deposit", () => {
  const value = normalizeBookingRecord(validInput());
  assert.equal(value.depositAmountMinor, 125001);
  assert.equal(value.balanceAmountMinor, 125000);
  assert.equal(value.currency, "THB");
});

test("rejects invalid guest, date, currency and idempotency data", () => {
  assert.throws(() => normalizeBookingRecord(validInput({ currency: "THB!" })), e => e.code === "INVALID_BOOKING_RECORD");
  assert.throws(() => normalizeBookingRecord(validInput({ checkOut: "2027-03-09" })), e => e.code === "INVALID_DATE_RANGE");
  assert.throws(() => normalizeBookingRecord(validInput({ idempotencyKey: "x" })), e => e.code === "INVALID_BOOKING_RECORD");
  assert.throws(() => normalizeBookingRecord(validInput({ guest: { name: "A", phone: "123" } })), e => e.code === "INVALID_GUEST_NAME");
});

test("creates tenant-scoped booking records idempotently", async () => {
  const db = fakeDb();
  const first = await createBookingRecord(db, "hotel-a", validInput());
  const repeat = await createBookingRecord(db, "hotel-a", validInput());
  const otherTenant = await createBookingRecord(db, "hotel-b", validInput());
  assert.equal(first.created, true);
  assert.equal(repeat.created, false);
  assert.equal(repeat.bookingId, first.bookingId);
  assert.equal(otherTenant.created, true);
  assert.notEqual(otherTenant.bookingId, first.bookingId);
  await assert.rejects(
    () => createBookingRecord(db, "hotel-a", validInput({ totalAmountMinor: 300000 })),
    e => e.code === "BOOKING_IDEMPOTENCY_COLLISION"
  );
});

test("accepts a verified exact deposit and makes duplicate webhook delivery harmless", async () => {
  const db = fakeDb();
  const booking = await createBookingRecord(db, "hotel-a", validInput());
  const event = {
    signatureVerified: true,
    eventId: "evt_deposit_123",
    bookingId: booking.bookingId,
    paymentId: "pay_123",
    amountMinor: 125001,
    currency: "THB",
    status: "succeeded",
  };
  const first = await recordVerifiedDeposit(db, "hotel-a", "testpay", event);
  const duplicate = await recordVerifiedDeposit(db, "hotel-a", "testpay", event);
  assert.deepEqual(first, { accepted: true, duplicate: false, state: "payment_verified" });
  assert.deepEqual(duplicate, { accepted: false, duplicate: true, state: "already_processed" });
});

test("normalizes payment event identifiers before deduplication", async () => {
  const db = fakeDb();
  const booking = await createBookingRecord(db, "hotel-a", validInput());
  const event = {
    signatureVerified: true,
    eventId: " evt_trimmed_123 ",
    bookingId: ` ${booking.bookingId} `,
    paymentId: " pay_trimmed_123 ",
    amountMinor: 125001,
    currency: " thb ",
    status: "succeeded",
  };
  const result = await recordVerifiedDeposit(db, "hotel-a", "testpay", event);
  assert.equal(result.state, "payment_verified");
  const duplicate = await recordVerifiedDeposit(db, "hotel-a", "testpay", {
    ...event, eventId: "evt_trimmed_123", bookingId: booking.bookingId,
    paymentId: "pay_trimmed_123", currency: "THB",
  });
  assert.equal(duplicate.duplicate, true);
});

test("rejects payment events without verified signatures or matching tenant bookings", async () => {
  const db = fakeDb();
  const booking = await createBookingRecord(db, "hotel-a", validInput());
  const base = {
    eventId: "evt_deposit_456", bookingId: booking.bookingId,
    paymentId: "pay_456", amountMinor: 125001, currency: "THB", status: "succeeded",
  };
  await assert.rejects(() => recordVerifiedDeposit(db, "hotel-a", "testpay", {
    ...base, signatureVerified: false,
  }), e => e.code === "INVALID_VERIFIED_PAYMENT_EVENT");
  await assert.rejects(() => recordVerifiedDeposit(db, "hotel-b", "testpay", {
    ...base, signatureVerified: true,
  }), e => e.code === "BOOKING_NOT_FOUND");
});
