const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BATCH_LIMIT,
  CURRENT_PRIVACY_POLICY_VERSION,
  isRetentionApplyAuthorized,
  countEligibleConversations,
  cleanupTenantRetention,
  runRetentionCleanup
} = require("../retention-cleanup");

test("retention deletion requires both an explicit CLI flag and an environment opt-in", () => {
  assert.equal(isRetentionApplyAuthorized(["--apply"], { RETENTION_CLEANUP_ENABLED: "true" }), true);
  assert.equal(isRetentionApplyAuthorized(["--apply"], { RETENTION_CLEANUP_ENABLED: "false" }), false);
  assert.equal(isRetentionApplyAuthorized([], { RETENTION_CLEANUP_ENABLED: "true" }), false);
});

test("retention dry run counts eligible conversations without opening a write transaction", async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ eligible: 4 }] }; } };
  const result = await cleanupTenantRetention(db, { id: "org-1", slug: "hotel-a", retention_days: 90 }, false);
  assert.equal(result.eligible, 4);
  assert.equal(result.deleted, 0);
  assert.equal(result.dryRun, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /e.status<>'resolved'/);
});

test("retention apply deletes only a bounded batch and writes an audit event", async () => {
  const statements = [];
  const client = {
    query: async (sql, params) => {
      statements.push({ sql, params });
      if (sql.startsWith("WITH candidates")) return { rows: [{ deleted: 3 }] };
      if (sql.startsWith("SELECT count")) return { rows: [{ eligible: 2 }] };
      return { rows: [] };
    },
    release: () => statements.push({ released: true })
  };
  const pool = {
    query: async () => ({ rows: [{ eligible: 3 }] }),
    connect: async () => client
  };
  const result = await cleanupTenantRetention(pool, { id: "org-1", slug: "hotel-a", retention_days: 90 }, true);
  assert.equal(result.deleted, 3);
  assert.equal(result.remainingEligible, 2);
  assert.ok(statements.some(x => x.sql === "BEGIN"));
  assert.ok(statements.some(x => x.sql === "COMMIT"));
  const deleteSql = statements.find(x => x.sql?.startsWith("WITH candidates"));
  assert.equal(deleteSql.params[2], BATCH_LIMIT);
  assert.match(deleteSql.sql, /attribution_status='hotel_reported_unlinked'/);
  assert.ok(statements.some(x => x.sql?.includes("retention.cleanup_executed")));
  assert.ok(statements.some(x => x.released));
});

test("tenant sweep only selects workspaces with the current complete unrevoked privacy approval", async () => {
  let query;
  const pool = { query: async (sql, params) => { query = { sql, params }; return { rows: [] }; } };
  const results = await runRetentionCleanup(pool, true);
  assert.deepEqual(results, []);
  assert.equal(query.params[0], CURRENT_PRIVACY_POLICY_VERSION);
  assert.match(query.sql, /p.revoked_at IS NULL/);
  assert.match(query.sql, /p.deletion_acknowledged=true/);
  assert.match(query.sql, /conversation_retention_days>0/);
});
