"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApprovedKnowledge } = require("../hotel-knowledge");

test("approved knowledge is tenant-scoped and requires a current review date", async () => {
  let receivedSql;
  let receivedParams;
  const expectedRows = [{ title: "Breakfast", category: "dining", content: "7:00–10:00" }];
  const db = {
    async query(sql, params) {
      receivedSql = sql;
      receivedParams = params;
      return expectedRows;
    },
  };

  const result = await loadApprovedKnowledge(
    db,
    "hotel-aster",
    new Date("2026-11-23T19:45:00.000Z"),
  );

  assert.equal(result, expectedRows);
  assert.match(receivedSql, /organization_id=\$1/);
  assert.match(receivedSql, /approved=true/);
  assert.match(receivedSql, /review_due_at IS NOT NULL AND review_due_at >= \$2::date/);
  assert.match(receivedSql, /ORDER BY updated_at DESC LIMIT 40/);
  assert.deepEqual(receivedParams, ["hotel-aster", "2026-11-23"]);
});

test("approved knowledge accepts an explicit ISO date for deterministic review filtering", async () => {
  let receivedParams;
  const db = {
    async query(_sql, params) {
      receivedParams = params;
      return [];
    },
  };

  await loadApprovedKnowledge(db, "hotel-birch", "2026-12-01");

  assert.deepEqual(receivedParams, ["hotel-birch", "2026-12-01"]);
});

test("database errors are not silently converted into empty hotel knowledge", async () => {
  const db = {
    async query() {
      throw new Error("database unavailable");
    },
  };

  await assert.rejects(
    () => loadApprovedKnowledge(db, "hotel-cedar", "2026-11-23"),
    /database unavailable/,
  );
});
