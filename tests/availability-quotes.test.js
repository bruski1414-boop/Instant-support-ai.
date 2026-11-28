"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAvailabilityQuotes } = require("../availability-quotes");

function fixture(rooms) {
  const calls = [];
  const inserted = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO hotel_availability_quotes")) {
        inserted.push(params);
        return {
          rowCount: 1,
          rows: [{
            id: "quote-" + inserted.length,
            room_type_id: params[1],
            room_type_name: params[2],
            check_in: params[3],
            check_out: params[4],
            guest_count: params[5],
            currency: params[6],
            amount_minor: String(params[7]),
            available_units: params[8],
            checked_at: params[9],
            expires_at: "2026-11-28T12:15:00.000Z",
          }],
        };
      }
      throw new Error("Unexpected SQL: " + sql);
    },
    release() {},
  };
  const db = {
    calls,
    inserted,
    async query(sql, params) {
      calls.push({ sql, params });
      assert.match(sql, /organization_id=\$1 AND status='connected'/);
      return { rowCount: 1, rows: [{ provider: "mews", encrypted_credentials: "ciphertext" }] };
    },
    async connect() { return client; },
  };
  return {
    db,
    vault: { decrypt(value) { assert.equal(value, "ciphertext"); return { token: "tenant-secret" }; } },
    pmsRegistry: {
      async getAvailability(provider, dates, context) {
        assert.equal(provider, "mews");
        assert.deepEqual(dates, { checkIn: "2027-03-10", checkOut: "2027-03-12", guestCount: 2 });
        assert.deepEqual(context, { credentials: { token: "tenant-secret" }, organizationId: "hotel-a" });
        return rooms;
      },
    },
  };
}

test("persists expiring tenant-scoped quotes from checked PMS rates", async () => {
  const f = fixture([
    { roomTypeId: "villa", roomTypeName: "Ocean Villa", currency: "THB", amountMinor: 250000, availableUnits: 2 },
    { roomTypeId: "suite", roomTypeName: "Garden Suite", currency: "THB", amountMinor: 180000, availableUnits: 1 },
  ]);
  const result = await createAvailabilityQuotes({
    ...f, organizationId: "hotel-a", checkIn: "2027-03-10", checkOut: "2027-03-12", guestCount: 2,
  });
  assert.equal(result.status, "checked");
  assert.equal(result.quotes.length, 2);
  assert.equal(result.quotes[0].quoteId, "quote-1");
  assert.equal(result.quotes[0].amountMinor, 250000);
  assert.equal(result.quotes[0].checkIn, "2027-03-10");
  assert.equal(result.quotes[0].guestCount, 2);
  assert.equal(f.db.inserted[0][0], "hotel-a");
  assert.equal(f.db.inserted[0][10], 900);
  assert.equal(f.db.calls.filter(x => x.sql === "BEGIN").length, 1);
  assert.equal(f.db.calls.filter(x => x.sql === "COMMIT").length, 1);
});

test("does not persist unavailable or zero-priced rooms as bookable quotes", async () => {
  const f = fixture([
    { roomTypeId: "sold", roomTypeName: "Sold Room", currency: "THB", amountMinor: 100000, availableUnits: 0 },
    { roomTypeId: "free", roomTypeName: "Invalid Free Rate", currency: "THB", amountMinor: 0, availableUnits: 1 },
  ]);
  const result = await createAvailabilityQuotes({
    ...f, organizationId: "hotel-a", checkIn: "2027-03-10", checkOut: "2027-03-12", guestCount: 2,
  });
  assert.deepEqual(result.quotes, []);
  assert.equal(result.reason, "no_bookable_rate");
  assert.equal(f.db.inserted.length, 0);
});

test("does not create quotes when the PMS availability state is unknown", async () => {
  const f = fixture([]);
  f.db.query = async () => ({ rowCount: 0, rows: [] });
  const result = await createAvailabilityQuotes({
    ...f, organizationId: "hotel-a", checkIn: "2027-03-10", checkOut: "2027-03-12", guestCount: 2,
  });
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.quotes, []);
  assert.equal(f.db.inserted.length, 0);
});

test("rejects an unsafe quote lifetime", async () => {
  const f = fixture([]);
  await assert.rejects(() => createAvailabilityQuotes({
    ...f, organizationId: "hotel-a", checkIn: "2027-03-10", checkOut: "2027-03-12", ttlSeconds: 30,
  }), error => error.code === "INVALID_QUOTE_TTL");
});
