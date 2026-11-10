const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { createApp } = require("../server");
const { hashPassword } = require("../auth");

const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLE = "veyra_auth_test";
const PASSWORD = "ci-only-test-password";

async function main() {
  const admin = new Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "postgres",
  });
  let runtimePool;
  let server;
  try {
    await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT CONNECT ON DATABASE postgres TO ${ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);

    const passwordHash = await hashPassword("a-ci-only-long-password");
    await admin.query("INSERT INTO organizations (id, name) VALUES ($1, 'Auth Test Hotel')", [TENANT_ID]);
    await admin.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, 'auth-test@example.test', $2)",
      [USER_ID, passwordHash]
    );
    await admin.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
      [TENANT_ID, USER_ID]
    );
    await admin.query(
      "INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, 'auth-test@example.test', $2)",
      [USER_ID, passwordHash]
    );

    runtimePool = new Pool({
      host: process.env.PGHOST || "127.0.0.1",
      port: Number(process.env.PGPORT || 5432),
      user: ROLE,
      password: PASSWORD,
      database: process.env.PGDATABASE || "postgres",
      max: 3,
    });
    const app = createApp({ dbPool: runtimePool, env: { NODE_ENV: "test" }, logger: { error() {} } });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const origin = base;

    const invalid = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "auth-test@example.test", password: "incorrect-password" }),
    });
    assert.equal(invalid.status, 401, "invalid password must be rejected");

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "AUTH-TEST@example.test", password: "a-ci-only-long-password" }),
    });
    assert.equal(login.status, 200, "valid credentials should create a session");
    const cookieHeader = login.headers.get("set-cookie") || "";
    const sessionMatch = cookieHeader.match(/veyra_session=([^;,]+)/);
    const csrfMatch = cookieHeader.match(/veyra_csrf=([^;,]+)/);
    assert.ok(sessionMatch && csrfMatch, "login must set session and CSRF cookies");
    const cookies = `veyra_session=${sessionMatch[1]}; veyra_csrf=${csrfMatch[1]}`;

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookies } });
    assert.equal(me.status, 200, "session should authenticate");
    const profile = await me.json();
    assert.equal(profile.authenticated, true);
    assert.equal(profile.user.email, "auth-test@example.test");
    assert.equal(profile.memberships.length, 1);
    assert.equal(profile.memberships[0].role, "owner");

    const dashboard = await fetch(`${base}/dashboard.html`, { headers: { cookie: cookies }, redirect: "manual" });
    assert.equal(dashboard.status, 200, "valid session and membership should open the dashboard");
    assert.match(await dashboard.text(), /Veyra AI command centre/);

    const csrf = decodeURIComponent(csrfMatch[1]);
    const logout = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: cookies, "x-csrf-token": csrf, origin },
    });
    assert.equal(logout.status, 200, "CSRF-protected logout should revoke session");
    const afterLogout = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookies } });
    assert.equal(afterLogout.status, 401, "revoked session must no longer authenticate");
    const dashboardAfterLogout = await fetch(`${base}/dashboard.html`, { headers: { cookie: cookies }, redirect: "manual" });
    assert.equal(dashboardAfterLogout.status, 303, "revoked session must not open the dashboard");
    assert.equal(dashboardAfterLogout.headers.get("location"), "/login.html");

    process.stdout.write("PostgreSQL-backed login, dashboard gate, profile, CSRF logout, and session revocation passed.\n");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (runtimePool) await runtimePool.end();
    try {
      await admin.query("DELETE FROM organizations WHERE id = $1", [TENANT_ID]);
      await admin.query("DELETE FROM users WHERE id = $1", [USER_ID]);
      await admin.query(`DROP OWNED BY ${ROLE}`);
      await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
    } catch (error) {
      process.stderr.write(`Test cleanup warning: ${error.message}\n`);
    }
    await admin.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Authentication integration test failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
