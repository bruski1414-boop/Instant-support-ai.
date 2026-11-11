const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { Pool } = require("pg");

const databaseUrl = process.env.TEST_DATABASE_URL;
test("two hotel workspaces remain isolated across live API resources", { skip: !databaseUrl }, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  let child;
  let baseUrl;
  const password = "test-password-for-hotel-owner";
  const scrypt = promisify(crypto.scrypt);

  async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  async function request(path, options = {}, session) {
    const headers = { ...(options.headers || {}) };
    if (session) {
      headers.cookie = session.cookie;
      if (options.method && !["GET", "HEAD"].includes(options.method)) {
        headers["X-CSRF-Token"] = session.csrfToken;
      }
    }
    return fetch(baseUrl + path, { ...options, headers });
  }

  async function login(slug, email) {
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationSlug: slug, email, password })
    });
    assert.equal(response.status, 200, "each hotel's owner should be able to sign in");
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    const body = await response.json();
    assert.ok(cookie, "login should issue a session cookie");
    assert.ok(body.csrfToken, "login should issue a CSRF token");
    return { cookie, csrfToken: body.csrfToken };
  }

  t.after(async () => {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await pool.end();
  });

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const bootstrapToken = crypto.randomBytes(24).toString("hex");
  child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: "false",
      OPENAI_API_KEY: "",
      BOOTSTRAP_TOKEN: bootstrapToken,
      GUEST_DATA_STORAGE_ENABLED: "false",
      ALLOWED_ORIGINS: "http://localhost:3000"
    },
    stdio: "ignore"
  });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Database-backed Veyra server exited during startup");
    try {
      const response = await fetch(baseUrl + "/api/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "database-backed server should initialize its schema");

  const firstSetup = await request("/api/setup/organization", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Bootstrap-Token": bootstrapToken },
    body: JSON.stringify({ organizationName: "Hotel Alpha", email: "owner@alpha.test", password })
  });
  assert.equal(firstSetup.status, 201);
  const alpha = await pool.query("SELECT id,slug FROM organizations WHERE slug='hotel-alpha'");
  assert.equal(alpha.rowCount, 1);

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = salt + ":" + Buffer.from(await scrypt(password, salt, 64)).toString("hex");
  const betaOrg = await pool.query(
    "INSERT INTO organizations(name,slug) VALUES('Hotel Beta','hotel-beta') RETURNING id,slug"
  );
  const betaUser = await pool.query(
    "INSERT INTO users(organization_id,email,password_hash,role) VALUES($1,'owner@beta.test',$2,'owner') RETURNING id",
    [betaOrg.rows[0].id, passwordHash]
  );

  const alphaId = alpha.rows[0].id;
  const betaId = betaOrg.rows[0].id;
  const alphaUser = await pool.query("SELECT id FROM users WHERE organization_id=$1 AND email='owner@alpha.test'", [alphaId]);
  const alphaDoc = await pool.query(
    "INSERT INTO knowledge_documents(organization_id,title,category,content,approved,updated_by) VALUES($1,'Alpha breakfast','food','Alpha serves breakfast at 7am.',true,$2) RETURNING id",
    [alphaId, alphaUser.rows[0].id]
  );
  const betaDoc = await pool.query(
    "INSERT INTO knowledge_documents(organization_id,title,category,content,approved,updated_by) VALUES($1,'Beta breakfast','food','Beta serves breakfast at 8am.',true,$2) RETURNING id",
    [betaId, betaUser.rows[0].id]
  );
  await pool.query(
    "INSERT INTO knowledge_document_versions(organization_id,document_id,title,category,content,approved,changed_by) VALUES($1,$2,'Alpha breakfast','food','Alpha serves breakfast at 7am.',true,$3)",
    [alphaId, alphaDoc.rows[0].id, alphaUser.rows[0].id]
  );
  await pool.query(
    "INSERT INTO organization_settings(organization_id,website_url,support_email) VALUES($1,'https://alpha.test','alpha@alpha.test'),($2,'https://beta.test','beta@beta.test')",
    [alphaId, betaId]
  );
  const alphaConversation = await pool.query(
    "INSERT INTO conversations(organization_id,status) VALUES($1,'escalated') RETURNING id",
    [alphaId]
  );
  const betaConversation = await pool.query(
    "INSERT INTO conversations(organization_id,status) VALUES($1,'open') RETURNING id",
    [betaId]
  );
  await pool.query(
    "INSERT INTO messages(conversation_id,role,content) VALUES($1,'guest','Private Alpha guest message'),($2,'guest','Private Beta guest message')",
    [alphaConversation.rows[0].id, betaConversation.rows[0].id]
  );
  const alphaEscalation = await pool.query(
    "INSERT INTO escalations(organization_id,conversation_id,reason) VALUES($1,$2,'Alpha private escalation') RETURNING id",
    [alphaId, alphaConversation.rows[0].id]
  );
  await pool.query(
    "INSERT INTO escalations(organization_id,conversation_id,reason) VALUES($1,$2,'Beta private escalation')",
    [betaId, betaConversation.rows[0].id]
  );
  await pool.query(
    "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type) VALUES($1,$2,'alpha.private_event','test'),($3,$4,'beta.private_event','test')",
    [alphaId, alphaUser.rows[0].id, betaId, betaUser.rows[0].id]
  );
  await pool.query(
    "INSERT INTO organization_storage_connections(organization_id,provider,workspace_reference,status) VALUES($1,'google_drive','alpha-drive','connected'),($2,'microsoft_sharepoint','beta-sharepoint','connected')",
    [alphaId, betaId]
  );

  const alphaSession = await login("hotel-alpha", "owner@alpha.test");
  const betaSession = await login("hotel-beta", "owner@beta.test");

  for (const [session, ownTitle, otherTitle, ownUrl, otherUrl, ownEmail, otherEmail, ownEvent, otherEvent, ownStorage, otherStorage] of [
    [alphaSession, "Alpha breakfast", "Beta breakfast", "https://alpha.test", "https://beta.test", "owner@alpha.test", "owner@beta.test", "alpha.private_event", "beta.private_event", "google", "microsoft"],
    [betaSession, "Beta breakfast", "Alpha breakfast", "https://beta.test", "https://alpha.test", "owner@beta.test", "owner@alpha.test", "beta.private_event", "alpha.private_event", "microsoft", "google"]
  ]) {
    const [knowledge, settings, users, audit, escalations, storage, overview] = await Promise.all([
      request("/api/admin/knowledge", {}, session),
      request("/api/admin/settings", {}, session),
      request("/api/admin/users", {}, session),
      request("/api/admin/audit", {}, session),
      request("/api/admin/escalations", {}, session),
      request("/api/admin/storage/connections", {}, session),
      request("/api/admin/overview", {}, session)
    ]);
    for (const response of [knowledge, settings, users, audit, escalations, storage, overview]) assert.equal(response.status, 200);
    const [k, s, u, a, e, st, o] = await Promise.all([
      knowledge.json(), settings.json(), users.json(), audit.json(), escalations.json(), storage.json(), overview.json()
    ]);
    assert.ok(k.documents.some((item) => item.title === ownTitle));
    assert.ok(!k.documents.some((item) => item.title === otherTitle));
    assert.equal(s.settings.website_url, ownUrl);
    assert.ok(u.users.some((item) => item.email === ownEmail));
    assert.ok(!u.users.some((item) => item.email === otherEmail));
    assert.ok(a.events.some((item) => item.action === ownEvent));
    assert.ok(!a.events.some((item) => item.action === otherEvent));
    assert.ok(e.escalations.some((item) => item.reason.includes(ownTitle.split(" ")[0])));
    assert.ok(!e.escalations.some((item) => item.reason.includes(otherTitle.split(" ")[0])));
    assert.ok(st.connections.some((item) => item.provider === ownStorage));
    assert.ok(!st.connections.some((item) => item.provider === otherStorage));
    assert.equal(o.conversations.length, 1);
    assert.ok(!JSON.stringify(o).includes("Private " + (ownTitle.startsWith("Alpha") ? "Beta" : "Alpha") + " guest message"));
  }

  const crossTenantChecks = [
    ["GET", `/api/admin/knowledge/${alphaDoc.rows[0].id}/versions`, undefined, betaSession, 404],
    ["PATCH", `/api/admin/knowledge/${alphaDoc.rows[0].id}`, { content: "Attempted cross-hotel edit." }, betaSession, 404],
    ["DELETE", `/api/admin/knowledge/${alphaDoc.rows[0].id}`, undefined, betaSession, 404],
    ["GET", `/api/admin/conversations/${alphaConversation.rows[0].id}`, undefined, betaSession, 404],
    ["DELETE", `/api/admin/conversations/${alphaConversation.rows[0].id}`, undefined, betaSession, 404],
    ["PATCH", `/api/admin/escalations/${alphaEscalation.rows[0].id}`, { status: "resolved" }, betaSession, 404],
    ["PATCH", `/api/admin/users/${alphaUser.rows[0].id}`, { active: false }, betaSession, 404]
  ];
  for (const [method, path, body, session, expected] of crossTenantChecks) {
    const response = await request(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {})
    }, session);
    assert.equal(response.status, expected, `${method} ${path} must not cross hotel boundaries`);
  }

  const alphaTranscript = await request(`/api/admin/conversations/${alphaConversation.rows[0].id}`, {}, alphaSession);
  assert.equal(alphaTranscript.status, 200);
  assert.match((await alphaTranscript.text()), /Private Alpha guest message/);
  const betaTranscript = await request(`/api/admin/conversations/${alphaConversation.rows[0].id}`, {}, betaSession);
  assert.equal(betaTranscript.status, 404);
});
