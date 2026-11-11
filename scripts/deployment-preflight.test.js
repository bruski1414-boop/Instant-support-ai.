const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_TABLES, validateEnvironment, runPreflight } = require("./deployment-preflight");

const goodEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://runtime:example@localhost:5432/veyra",
  DATABASE_SSL: "true",
  OPENAI_API_KEY: "test-key-not-used",
  TENANT_INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  APP_ORIGIN: "https://veyra-staging.example",
};

function fakePool(options = {}) {
  let ended = false;
  return {
    async query(sql) {
      if (sql.includes("FROM pg_roles")) return { rows: [options.role || {
        rolname: "veyra_runtime", rolsuper: false, rolbypassrls: false,
        rolcreatedb: false, rolcreaterole: false, rolcanlogin: true,
      }] };
      if (sql.includes("information_schema.tables")) {
        return { rows: (options.tables || REQUIRED_TABLES).map((table_name) => ({ table_name })) };
      }
      if (sql.includes("owned_count")) return { rows: [{ owned_count: options.ownedCount || 0 }] };
      if (sql.includes("FROM pg_class c JOIN pg_namespace")) {
        return { rows: (options.rls || REQUIRED_TABLES.map((table_name) => ({
          table_name, relrowsecurity: true, relforcerowsecurity: true, has_policy: true,
        }))) };
      }
      throw new Error("Unexpected SQL in preflight test");
    },
    async end() { ended = true; },
    get ended() { return ended; },
  };
}

test("production environment accepts an exact HTTPS origin and a 32-byte key", () => {
  assert.deepEqual(validateEnvironment(goodEnv), []);
});

test("preflight blocks missing secrets before opening a database connection", async () => {
  let opened = false;
  const result = await runPreflight({
    env: { NODE_ENV: "production" },
    poolFactory: () => { opened = true; throw new Error("should not open"); },
  });
  assert.equal(result.ok, false);
  assert.equal(opened, false);
  assert.ok(result.issues.some((issue) => issue.includes("DATABASE_URL")));
});

test("preflight passes only with a restricted runtime role and complete RLS schema", async () => {
  const pool = fakePool();
  const result = await runPreflight({ env: goodEnv, poolFactory: () => pool });
  assert.deepEqual(result, { ok: true, issues: [] });
  assert.equal(pool.ended, true);
});

test("preflight rejects privileged database roles", async () => {
  const pool = fakePool({ role: {
    rolname: "postgres", rolsuper: true, rolbypassrls: true,
    rolcreatedb: true, rolcreaterole: true, rolcanlogin: true,
  } });
  const result = await runPreflight({ env: goodEnv, poolFactory: () => pool });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("superuser")));
  assert.ok(result.issues.some((issue) => issue.includes("create databases")));
});

test("preflight rejects missing tables, incomplete RLS, and app-owned tables", async () => {
  const pool = fakePool({
    tables: REQUIRED_TABLES.filter((table) => table !== "tenant_widget_settings"),
    rls: [{ table_name: "organizations", relrowsecurity: true, relforcerowsecurity: false, has_policy: true }],
    ownedCount: 2,
  });
  const result = await runPreflight({ env: goodEnv, poolFactory: () => pool });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("tenant_widget_settings")));
  assert.ok(result.issues.some((issue) => issue.includes("Row-level security")));
  assert.ok(result.issues.some((issue) => issue.includes("must not own")));
});

test("preflight rejects non-HTTPS origins and malformed encryption keys", () => {
  assert.ok(validateEnvironment({ ...goodEnv, APP_ORIGIN: "http://veyra.example" }).some((issue) => issue.includes("APP_ORIGIN")));
  assert.ok(validateEnvironment({ ...goodEnv, TENANT_INTEGRATION_ENCRYPTION_KEY: "not-a-key" }).some((issue) => issue.includes("32 random bytes")));
  assert.ok(validateEnvironment({ ...goodEnv, APP_ORIGIN: "https://veyra.example/path" }).some((issue) => issue.includes("APP_ORIGIN")));
});


test("preflight rejects production database connections without verified TLS", () => {
  const { DATABASE_SSL, ...withoutTls } = goodEnv;
  assert.ok(validateEnvironment(withoutTls).some((issue) => issue.includes("DATABASE_SSL must be true")));
  assert.ok(validateEnvironment({ ...goodEnv, DATABASE_SSL: "false" }).some((issue) => issue.includes("DATABASE_SSL must be true")));
});
