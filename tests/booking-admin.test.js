"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { listHotelBookings, parseBookingListQuery } = require("../booking-admin");

test("lists only the authenticated hotel's bookings and uses bounded pagination", async () => {
  let captured;
  const db = { async query(sql, params) {
    captured = { sql, params };
    return { rows: [{ id: "booking-a", state: "awaiting_payment" }] };
  } };
  const result = await listHotelBookings({
    db, organizationId: "hotel-a", state: "awaiting_payment", limit: 25, offset: 50,
  });
  assert.deepEqual(result.bookings, [{ id: "booking-a", state: "awaiting_payment" }]);
  assert.deepEqual(captured.params, ["hotel-a", "awaiting_payment", 25, 50]);
  assert.match(captured.sql, /organization_id=\$1 AND state=\$2/);
  assert.match(captured.sql, /LIMIT \$3 OFFSET \$4/);
  assert.match(captured.sql, /ORDER BY created_at DESC,id DESC/);
  assert.doesNotMatch(captured.sql, /SELECT \*/);
});

test("does not accept arbitrary booking state filters", async () => {
  let queried = false;
  await assert.rejects(
    () => listHotelBookings({
      db: { async query() { queried = true; return { rows: [] }; } },
      organizationId: "hotel-a", state: "anything OR true",
    }),
    error => error.code === "INVALID_BOOKING_STATE_FILTER"
  );
  assert.equal(queried, false);
});

test("rejects invalid pagination instead of allowing unbounded reads", async () => {
  let queried = false;
  await assert.rejects(
    () => listHotelBookings({
      db: { async query() { queried = true; return { rows: [] }; } },
      organizationId: "hotel-a", limit: 1000, offset: 0,
    }),
    error => error.code === "INVALID_BOOKING_PAGINATION"
  );
  assert.equal(queried, false);
});

test("parses safe defaults and rejects malformed query parameters", () => {
  assert.deepEqual(parseBookingListQuery({}), { state: undefined, limit: 50, offset: 0 });
  assert.deepEqual(parseBookingListQuery({ state: "confirmed", limit: "20", offset: "10" }), {
    state: "confirmed", limit: 20, offset: 10,
  });
  assert.throws(() => parseBookingListQuery({ limit: "999" }), error => error.code === "INVALID_BOOKING_PAGINATION");
  assert.throws(() => parseBookingListQuery({ offset: "-1" }), error => error.code === "INVALID_BOOKING_PAGINATION");
});
