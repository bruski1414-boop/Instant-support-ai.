"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPostgresMewsIdempotencyStore } = require("../mews-reservation-idempotency-store");

function fakeDb() {
  const rows = new Map();
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("CREATE TABLE IF NOT EXISTS mews_reservation_idempotency")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.startsWith("INSERT INTO mews_reservation_idempotency")) {
        const key = params[0] + ":" + params[1];
        if (rows.has(key)) return { rowCount: 0, rows: [] };
        rows.set(key, { organization_id: params[0], idempotency_key: params[1], request_sha256: params[2], status: "in_progress", result: null });
        return { rowCount: 1, rows: [{ status: "in_progress" }] };
      }
      if (sql.startsWith("SELECT request_sha256")) {
        const row = rows.get(params[0] + ":" + params[1]);
        return row ? { rowCount: 1, rows: [{ request_sha256: row.request_sha256, status: row.status, result: row.result }] } : { rowCount: 0, rows: [] };
      }
      if (sql.startsWith("UPDATE mews_reservation_idempotency SET status='completed'")) {
        const row = rows.get(params[0] + ":" + params[1]);
        if (!row || row.request_sha256 !== params[2] || row.status !== "in_progress") return { rowCount: 0, rows: [] };
        row.status = "completed";
        row.result = JSON.parse(params[3]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE mews_reservation_idempotency SET status='uncertain'")) {
        const row = rows.get(params[0] + ":" + params[1]);
        if (!row || row.request_sha256 !== params[2] || row.status !== "in_progress") return { rowCount: 0, rows: [] };
        row.status = "uncertain";
        row.result = null;
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected SQL in fake database.");
    }
  };
}

const context = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  idempotencyKey: "reservation_12345678901234567890",
  requestHash: "a".repeat(64)
};

test("creates a durable store and initializes its tenant-scoped schema", async () => {
  const db = fakeDb();
  const store = createPostgresMewsIdempotencyStore({ db });
  assert.equal(store.durable, true);
  await store.ensureSchema();
  assert.match(db.calls[0].sql, /PRIMARY KEY \(organization_id, idempotency_key\)/);
});

test("atomically claims a new request and prevents a second writer", async () => {
  const store = createPostgresMewsIdempotencyStore({ db: fakeDb() });
  assert.deepEqual(await store.claim(context), { status: "acquired" });
  assert.deepEqual(await store.claim(context), { status: "in_progress" });
});

test("returns the stored result for a completed request and detects key reuse", async () => {
  const store = createPostgresMewsIdempotencyStore({ db: fakeDb() });
  await store.claim(context);
  const result = { status: "confirmed", bookingReference: "DEMO-1" };
  await store.complete({ ...context, result });
  assert.deepEqual(await store.claim(context), { status: "completed", result });
  assert.deepEqual(await store.claim({ ...context, requestHash: "b".repeat(64) }), { status: "conflict" });
});

test("marks ambiguous writes uncertain and does not grant a second claim", async () => {
  const store = createPostgresMewsIdempotencyStore({ db: fakeDb() });
  await store.claim(context);
  await store.markUncertain({ ...context, reason: "provider_timeout" });
  assert.deepEqual(await store.claim(context), { status: "uncertain" });
});

test("rejects malformed request hashes and incomplete contexts", async () => {
  const store = createPostgresMewsIdempotencyStore({ db: fakeDb() });
  await assert.rejects(() => store.claim({ ...context, requestHash: "bad" }), /SHA-256/);
  await assert.rejects(() => store.claim({ ...context, organizationId: "" }), /organizationId/);
});
