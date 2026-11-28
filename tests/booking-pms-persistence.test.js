"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { recordPmsOutcome, claimPmsBookingAttempt } = require("../booking-repository");

function makeDb(initialState = "payment_verified") {
  const row = { id: "booking-1", state: initialState, pms_provider: null, pms_booking_id: null };
  const attempt = { status: "started", pms_booking_id: null };
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.startsWith("SELECT id,state FROM hotel_bookings")) {
        return { rowCount: row.id === params[0] ? 1 : 0, rows: row.id === params[0] ? [{ id: row.id, state: row.state }] : [] };
      }
      if (sql.startsWith("SELECT id FROM hotel_bookings WHERE id=$1 AND organization_id=$2 AND pms_provider")) {
        return { rowCount: row.pms_provider === params[2] && row.pms_booking_id === params[3] ? 1 : 0, rows: [] };
      }
      if (sql.startsWith("UPDATE hotel_bookings SET state='confirmed'")) {
        Object.assign(row, { state: "confirmed", pms_provider: params[2], pms_booking_id: params[3] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE hotel_bookings SET state='booking_pending'")) {
        Object.assign(row, { state: "booking_pending", pms_provider: params[2], pms_booking_id: params[3], last_error_code: params[4] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE hotel_pms_booking_attempts SET status='confirmed'")) {
        Object.assign(attempt, { status: "confirmed", pms_booking_id: params[2] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE hotel_pms_booking_attempts SET status='pending'")) {
        Object.assign(attempt, { status: "pending", pms_booking_id: params[2] });
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected SQL: " + sql);
    },
    release() {},
  };
  return { row, attempt, queries, async connect() { return client; } };
}

test("persists confirmed PMS reference only after verified payment", async () => {
  const db = makeDb();
  const result = await recordPmsOutcome(db, "hotel-a", "booking-1", "mews", {
    state: "confirmed", pmsBookingId: "mews-res-987",
  });
  assert.deepEqual(result, { state: "confirmed", duplicate: false });
  assert.equal(db.row.state, "confirmed");
  assert.equal(db.row.pms_booking_id, "mews-res-987");
  assert.deepEqual(db.attempt, { status: "confirmed", pms_booking_id: "mews-res-987" });
  assert.equal(db.queries.at(-1).params[3], "mews");
});

test("persists uncertain PMS outcomes as pending, never confirmed", async () => {
  const db = makeDb();
  const result = await recordPmsOutcome(db, "hotel-a", "booking-1", "mews", {
    state: "booking_pending", reason: "pms_result_unknown",
  });
  assert.deepEqual(result, { state: "booking_pending", duplicate: false });
  assert.equal(db.row.state, "booking_pending");
  assert.equal(db.row.pms_booking_id, null);
  assert.equal(db.row.last_error_code, "pms_result_unknown");
  assert.deepEqual(db.attempt, { status: "pending", pms_booking_id: null });
});

test("rejects confirmation without a PMS reference and wrong hotel scope", async () => {
  const db = makeDb();
  await assert.rejects(
    () => recordPmsOutcome(db, "hotel-a", "booking-1", "mews", { state: "confirmed" }),
    e => e.code === "PMS_CONFIRMATION_REFERENCE_REQUIRED"
  );
  await assert.rejects(
    () => recordPmsOutcome(db, "hotel-b", "booking-1", "mews", { state: "confirmed", pmsBookingId: "res-1" }),
    e => e.code === "BOOKING_NOT_FOUND"
  );
});

test("confirmed records cannot be overwritten by a pending result", async () => {
  const db = makeDb("confirmed");
  await assert.rejects(
    () => recordPmsOutcome(db, "hotel-a", "booking-1", "mews", { state: "booking_pending", reason: "timeout" }),
    e => e.code === "BOOKING_ALREADY_CONFIRMED"
  );
});


test("claims a single automatic PMS submission per tenant booking", async () => {
  const attempts = new Set();
  const client = {
    async query(sql, params = []) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.startsWith("SELECT state FROM hotel_bookings")) {
        return { rowCount: 1, rows: [{ state: "payment_verified" }] };
      }
      if (sql.startsWith("INSERT INTO hotel_pms_booking_attempts")) {
        const key = params[0] + ":" + params[1];
        if (attempts.has(key)) return { rowCount: 0, rows: [] };
        attempts.add(key);
        return { rowCount: 1, rows: [{ booking_id: params[1] }] };
      }
      throw new Error("Unexpected SQL: " + sql);
    },
    release() {},
  };
  const db = { async connect() { return client; } };
  const first = await claimPmsBookingAttempt(db, "hotel-a", "booking-1", "mews");
  const duplicate = await claimPmsBookingAttempt(db, "hotel-a", "booking-1", "mews");
  assert.deepEqual(first, { claimed: true });
  assert.deepEqual(duplicate, { claimed: false });
});

test("does not claim a PMS attempt before payment verification", async () => {
  const client = {
    async query(sql) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.startsWith("SELECT state FROM hotel_bookings")) {
        return { rowCount: 1, rows: [{ state: "awaiting_payment" }] };
      }
      throw new Error("Unexpected SQL: " + sql);
    },
    release() {},
  };
  const db = { async connect() { return client; } };
  await assert.rejects(
    () => claimPmsBookingAttempt(db, "hotel-a", "booking-1", "mews"),
    e => e.code === "PAYMENT_NOT_VERIFIED"
  );
});
