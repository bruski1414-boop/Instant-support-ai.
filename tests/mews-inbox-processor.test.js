"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsInboxProcessor, normalizeMewsReservationSnapshot, retryDelayMs } = require("../mews-inbox-processor");

const reservationId = "33333333-3333-4333-8333-333333333333";
const serviceId = "44444444-4444-4444-8444-444444444444";
const row = {
  id: "inbox-1",
  organization_id: "org-1",
  enterprise_id: "11111111-1111-4111-8111-111111111111",
  entity_id: reservationId,
  attempt_count: 1
};
const reservation = {
  id: reservationId,
  serviceId,
  state: "Confirmed",
  scheduledStartUtc: "2026-12-01T15:00:00Z",
  scheduledEndUtc: "2026-12-03T11:00:00Z",
  updatedUtc: "2026-11-16T10:00:00Z",
  guestName: "Must never be stored",
  guestEmail: "private@example.invalid"
};

function fakeDb(claimed = [row], { currentAttemptCount = row.attempt_count } = {}) {
  const calls = [];
  return {
    calls,
    async connect() {
      return {
        async query(sql, params) {
          calls.push({ sql, params });
          if (sql.startsWith("WITH candidates")) return { rows: claimed };
          if (sql.startsWith("SELECT id FROM mews_webhook_inbox")) {
            return currentAttemptCount === params[1] ? { rows: [{ id: params[0] }], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 1 };
        },
        release() {}
      };
    },
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }
  };
}

test("normalizes only allowlisted Mews reservation fields", () => {
  const normalized = normalizeMewsReservationSnapshot(reservation, {
    expectedId: reservationId,
    expectedServiceId: serviceId
  });
  assert.deepEqual(Object.keys(normalized).sort(), [
    "reservationId", "scheduledEndUtc", "scheduledStartUtc", "serviceId", "state", "updatedUtc"
  ]);
  assert.equal(JSON.stringify(normalized).includes("private@example.invalid"), false);
  assert.equal(normalized.state, "Confirmed");
});

test("rejects a reservation outside the configured service and invalid timestamps", () => {
  assert.throws(() => normalizeMewsReservationSnapshot(reservation, {
    expectedId: reservationId,
    expectedServiceId: "55555555-5555-4555-8555-555555555555"
  }), /configured daily service/);
  assert.throws(() => normalizeMewsReservationSnapshot({ ...reservation, scheduledStartUtc: "tomorrow" }, {
    expectedId: reservationId,
    expectedServiceId: serviceId
  }), /valid UTC timestamp/);
  assert.throws(() => normalizeMewsReservationSnapshot({ ...reservation, scheduledEndUtc: "2026-11-30T11:00:00Z" }, {
    expectedId: reservationId,
    expectedServiceId: serviceId
  }), /end must be later/);
});

test("uses bounded exponential retry delays", () => {
  assert.equal(retryDelayMs(1), 5000);
  assert.equal(retryDelayMs(2), 10000);
  assert.equal(retryDelayMs(20), 900000);
  assert.throws(() => retryDelayMs(0), /positive integer/);
});

test("claims, fetches and stores a PII-free reservation snapshot atomically", async () => {
  const db = fakeDb();
  const mewsStore = {
    async resolve(orgId) {
      assert.equal(orgId, row.organization_id);
      return {
        propertyReference: row.enterprise_id,
        service: { id: serviceId },
        client: {
          async getReservations(input) {
            assert.deepEqual(input.reservationIds, [reservationId]);
            assert.deepEqual(input.enterpriseIds, [row.enterprise_id]);
            return { reservations: [reservation] };
          }
        }
      };
    }
  };
  const processor = createMewsInboxProcessor({ db, mewsStore });
  const result = await processor.processBatch();
  assert.deepEqual(result, { claimed: 1, processed: 1, retried: 0, failed: 0, stale: 0 });
  const insert = db.calls.find((call) => call.sql.startsWith("INSERT INTO mews_reservation_snapshots"));
  assert.ok(insert);
  assert.equal(insert.params.length, 8);
  assert.equal(insert.params.includes("Must never be stored"), false);
  assert.equal(insert.params.includes("private@example.invalid"), false);
  assert.ok(db.calls.some((call) => call.sql.includes("status='processed'")));
});

test("retries a temporary Mews failure without retaining provider error text", async () => {
  const db = fakeDb();
  const mewsStore = {
    async resolve() {
      return {
        propertyReference: row.enterprise_id,
        service: { id: serviceId },
        client: { async getReservations() { throw new Error("provider error with private@example.invalid"); } }
      };
    }
  };
  const processor = createMewsInboxProcessor({
    db,
    mewsStore,
    clock: () => new Date("2026-11-16T10:00:00Z")
  });
  const result = await processor.processBatch();
  assert.deepEqual(result, { claimed: 1, processed: 0, retried: 1, failed: 0, stale: 0 });
  const update = db.calls.find((call) => call.sql.startsWith("UPDATE mews_webhook_inbox SET status=$2"));
  assert.ok(update);
  assert.equal(update.params[1], "pending");
  assert.equal(update.params[3], "reservation_fetch_failed");
  assert.equal(JSON.stringify(db.calls).includes("private@example.invalid"), false);
});

test("a worker whose lease was reclaimed cannot write or complete the newer attempt", async () => {
  const db = fakeDb([row], { currentAttemptCount: row.attempt_count + 1 });
  const mewsStore = {
    async resolve() {
      return {
        propertyReference: row.enterprise_id,
        service: { id: serviceId },
        client: { async getReservations() { return { reservations: [reservation] }; } }
      };
    }
  };
  const processor = createMewsInboxProcessor({ db, mewsStore });
  const result = await processor.processBatch();
  assert.deepEqual(result, { claimed: 1, processed: 0, retried: 0, failed: 0, stale: 1 });
  assert.equal(db.calls.some((call) => call.sql.startsWith("INSERT INTO mews_reservation_snapshots")), false);
  assert.equal(db.calls.some((call) => call.sql.includes("status='processed'")), false);
});

test("a stale worker cannot reschedule a job after a newer attempt has claimed it", async () => {
  const db = fakeDb([row], { currentAttemptCount: row.attempt_count + 1 });
  const mewsStore = {
    async resolve() {
      return {
        propertyReference: row.enterprise_id,
        service: { id: serviceId },
        client: { async getReservations() { throw new Error("temporary provider failure"); } }
      };
    }
  };
  const processor = createMewsInboxProcessor({ db, mewsStore });
  const result = await processor.processBatch();
  assert.deepEqual(result, { claimed: 1, processed: 0, retried: 0, failed: 0, stale: 1 });
  const failureUpdate = db.calls.find((call) => call.sql.startsWith("UPDATE mews_webhook_inbox SET status=$2"));
  assert.ok(failureUpdate);
  assert.equal(failureUpdate.params[4], row.attempt_count);
});
