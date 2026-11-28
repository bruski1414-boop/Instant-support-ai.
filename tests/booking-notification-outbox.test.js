"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_ATTEMPTS,
  enqueueBookingNotification,
  processBookingNotificationOutbox,
  getBookingNotificationHealth
} = require("../booking-notification-outbox");

test("enqueue is idempotent per hotel and booking", async () => {
  const calls = [];
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    return { rowCount: 0, rows: [] };
  } };
  const result = await enqueueBookingNotification(db, "hotel-a", "booking-a");
  assert.deepEqual(result, { enqueued: false, notification: null });
  assert.match(calls[0].sql, /ON CONFLICT\(organization_id,booking_id,event_type\) DO NOTHING/);
  assert.deepEqual(calls[0].params, ["hotel-a", "booking-a"]);
});

test("worker claims a tenant-scoped job and marks successful delivery", async () => {
  const calls = [];
  let claimed = false;
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith("WITH candidate")) {
      if (claimed) return { rows: [] };
      claimed = true;
      return { rows: [{ id: "outbox-1", organization_id: "hotel-a", booking_id: "booking-a", attempts: 1 }] };
    }
    return { rowCount: 1, rows: [] };
  } };
  const result = await processBookingNotificationOutbox({
    db, organizationId: "hotel-a",
    deliver: async job => {
      assert.equal(job.booking_id, "booking-a");
      return { configured: true, delivered: true, status: "delivered" };
    }
  });
  assert.equal(result.processed, 1);
  assert.equal(result.results[0].status, "delivered");
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.equal(calls[0].params[2], "hotel-a");
  assert.match(calls[1].sql, /status='delivered'/);
});

test("failed delivery is rescheduled with backoff instead of discarded", async () => {
  const calls = [];
  let claimed = false;
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith("WITH candidate")) {
      if (claimed) return { rows: [] };
      claimed = true;
      return { rows: [{ id: "outbox-2", organization_id: "hotel-a", booking_id: "booking-b", attempts: 2 }] };
    }
    return { rowCount: 1, rows: [] };
  } };
  const result = await processBookingNotificationOutbox({
    db, organizationId: "hotel-a", deliver: async () => ({ delivered: false, status: "failed" })
  });
  assert.equal(result.results[0].status, "pending");
  assert.equal(result.results[0].retryInSeconds, 120);
  assert.match(calls[1].sql, /next_attempt_at=now\(\)/);
  assert.equal(calls[1].params[1], "pending");
  assert.equal(calls[1].params[3], "webhook_delivery_failed");
});

test("exhausted jobs move to dead letter for staff investigation", async () => {
  let claimed = false;
  const calls = [];
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith("WITH candidate")) {
      if (claimed) return { rows: [] };
      claimed = true;
      return { rows: [{ id: "outbox-3", organization_id: "hotel-a", booking_id: "booking-c", attempts: MAX_ATTEMPTS }] };
    }
    return { rowCount: 1, rows: [] };
  } };
  const result = await processBookingNotificationOutbox({
    db, deliver: async () => ({ delivered: false, status: "failed" })
  });
  assert.equal(result.results[0].status, "dead_letter");
  assert.equal(calls[1].params[1], "dead_letter");
});

test("health query is scoped to one hotel", async () => {
  let captured;
  const db = { async query(sql, params) {
    captured = { sql, params };
    return { rows: [{ pending: 1, processing: 0, delivered: 3, failed: 0 }] };
  } };
  const result = await getBookingNotificationHealth(db, "hotel-a");
  assert.equal(result.pending, 1);
  assert.deepEqual(captured.params, ["hotel-a"]);
  assert.match(captured.sql, /WHERE organization_id=\$1/);
});

test("worker rejects oversized batches", async () => {
  await assert.rejects(
    () => processBookingNotificationOutbox({ db: { query: async () => ({ rows: [] }) }, deliver: async () => ({}), batchSize: 21 }),
    RangeError
  );
});
