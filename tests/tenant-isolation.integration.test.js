const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { encryptWebhookConfig } = require("../staff-webhook-security");

const databaseUrl = process.env.TEST_DATABASE_URL;
test("two hotel workspaces remain isolated across live API resources", { skip: !databaseUrl }, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  let child;
  let baseUrl;
  const webhookEncryptionKey = crypto.randomBytes(32).toString("base64");
  const password = "test-password-for-hotel-owner";

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
  const provisioningToken = crypto.randomBytes(24).toString("hex");
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
      PLATFORM_PROVISIONING_TOKEN: provisioningToken,
      STAFF_WEBHOOK_ENCRYPTION_KEY: webhookEncryptionKey,
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

  const deniedProvision = await request("/api/platform/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationName: "Hotel Beta", email: "owner@beta.test", password })
  });
  assert.equal(deniedProvision.status, 403, "additional hotel creation must require the platform provisioning secret");

  const provisionBeta = await request("/api/platform/organizations", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Platform-Provisioning-Token": provisioningToken },
    body: JSON.stringify({ organizationName: "Hotel Beta", email: "owner@beta.test", password })
  });
  assert.equal(provisionBeta.status, 201, "platform operator should be able to create another hotel workspace");
  const duplicateProvision = await request("/api/platform/organizations", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Platform-Provisioning-Token": provisioningToken },
    body: JSON.stringify({ organizationName: "Hotel Beta", email: "owner@other-beta.test", password })
  });
  assert.equal(duplicateProvision.status, 409, "duplicate hotel slugs must be rejected");

  const betaOrg = await pool.query("SELECT id,slug FROM organizations WHERE slug='hotel-beta'");
  const betaUser = await pool.query("SELECT id FROM users WHERE organization_id=$1 AND email='owner@beta.test'", [betaOrg.rows[0].id]);
  const alphaId = alpha.rows[0].id;
  const betaId = betaOrg.rows[0].id;
  await pool.query(
    "INSERT INTO organization_staff_webhooks(organization_id,encrypted_config,status) VALUES($1,$2,'configured'),($3,$4,'configured')",
    [
      alphaId,
      encryptWebhookConfig({ url: "https://alpha.example.test/veyra", secret: "alpha-signing-secret-for-integration-test" }, webhookEncryptionKey),
      betaId,
      encryptWebhookConfig({ url: "https://beta.example.test/veyra", secret: "beta-signing-secret-for-integration-test" }, webhookEncryptionKey)
    ]
  );
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
    "INSERT INTO messages(conversation_id,role,content) VALUES($1,'guest','Private Alpha guest message'),($1,'assistant','Private Alpha assistant reply'),($2,'guest','Private Beta guest message'),($2,'assistant','Private Beta assistant reply')",
    [alphaConversation.rows[0].id, betaConversation.rows[0].id]
  );
  const orderedMessages = await pool.query(
    "SELECT conversation_id,role,content,sequence_no FROM messages WHERE conversation_id=ANY($1::uuid[]) ORDER BY sequence_no",
    [[alphaConversation.rows[0].id, betaConversation.rows[0].id]]
  );
  assert.equal(orderedMessages.rowCount, 4, "each seeded conversation should retain its guest message and assistant reply");
  assert.equal(new Set(orderedMessages.rows.map((row) => row.sequence_no)).size, 4, "message insertion order should be globally unique");
  for (const conversationId of [alphaConversation.rows[0].id, betaConversation.rows[0].id]) {
    const conversationMessages = orderedMessages.rows.filter((row) => row.conversation_id === conversationId);
    assert.deepEqual(
      conversationMessages.map((row) => row.role),
      ["guest", "assistant"],
      "messages written in one transaction should retain guest-then-assistant order"
    );
  }
  const alphaEscalation = await pool.query(
    "INSERT INTO escalations(organization_id,conversation_id,reason) VALUES($1,$2,'Alpha private escalation') RETURNING id",
    [alphaId, alphaConversation.rows[0].id]
  );
  const betaEscalation = await pool.query(
    "INSERT INTO escalations(organization_id,conversation_id,reason) VALUES($1,$2,'Beta private escalation') RETURNING id",
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
  await pool.query(
    "INSERT INTO storage_connections(organization_id,provider,account_email,encrypted_tokens,status) VALUES($1,'google','storage@alpha.test','encrypted-alpha-placeholder','connected'),($2,'microsoft','storage@beta.test','encrypted-beta-placeholder','connected')",
    [alphaId, betaId]
  );

  const alphaSession = await login("hotel-alpha", "owner@alpha.test");
  const betaSession = await login("hotel-beta", "owner@beta.test");

  const normalizedAlphaSettings = await request("/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ website_url: "https://alpha.test/", support_email: "alpha@alpha.test", timezone: "UTC", language: "en" })
  }, alphaSession);
  assert.equal(normalizedAlphaSettings.status, 200, "hotel profile should accept and normalize a trailing slash on the website origin: " + await normalizedAlphaSettings.clone().text());

  const alphaCors = await fetch(baseUrl + "/api/public/hotel-alpha/chat", { method: "OPTIONS", headers: { Origin: "https://alpha.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  const betaCors = await fetch(baseUrl + "/api/public/hotel-beta/chat", { method: "OPTIONS", headers: { Origin: "https://beta.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  const unknownCors = await fetch(baseUrl + "/api/public/hotel-alpha/chat", { method: "OPTIONS", headers: { Origin: "https://unregistered.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  const alphaToBetaCors = await fetch(baseUrl + "/api/public/hotel-beta/chat", { method: "OPTIONS", headers: { Origin: "https://alpha.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  const betaToAlphaCors = await fetch(baseUrl + "/api/public/hotel-alpha/chat", { method: "OPTIONS", headers: { Origin: "https://beta.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  assert.equal(alphaCors.headers.get("access-control-allow-origin"), "https://alpha.test", "Hotel Alpha's saved website origin should be allowed");
  assert.equal(betaCors.headers.get("access-control-allow-origin"), "https://beta.test", "Hotel Beta's saved website origin should be allowed");
  assert.equal(unknownCors.headers.get("access-control-allow-origin"), null, "unregistered websites must not be allowed");
  assert.equal(alphaToBetaCors.headers.get("access-control-allow-origin"), null, "Hotel Alpha's website must not be allowed to call Hotel Beta's guest API");
  assert.equal(betaToAlphaCors.headers.get("access-control-allow-origin"), null, "Hotel Beta's website must not be allowed to call Hotel Alpha's guest API");

  const alphaAiCheck = await request("/api/admin/integrations/test-ai", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, alphaSession);
  assert.equal(alphaAiCheck.status, 503, "missing provider key must be reported rather than pretending AI is verified");

  for (const [session, expectedSlug] of [
    [alphaSession, "hotel-alpha"],
    [betaSession, "hotel-beta"]
  ]) {
    const config = await request("/api/admin/integrations/staff-webhook", {}, session);
    assert.equal(config.status, 200);
    const body = await config.json();
    assert.equal(body.configured, true, expectedSlug + " should see only its own configured webhook status");
    assert.equal(body.encryptionReady, true);
    assert.equal(JSON.stringify(body).includes("signing-secret"), false, "API must not reveal webhook secrets");
    assert.equal(JSON.stringify(body).includes("example.test"), false, "API must not reveal private webhook URLs");
  }

  const rejectedLocalWebhook = await request("/api/admin/integrations/staff-webhook", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "http://127.0.0.1:8080/private", secret: "alpha-signing-secret-for-integration-test" })
  }, alphaSession);
  assert.equal(rejectedLocalWebhook.status, 400, "local and non-HTTPS webhook targets must be rejected");

  const crossTenantRemove = await request("/api/admin/integrations/staff-webhook", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}"
  }, alphaSession);
  assert.equal(crossTenantRemove.status, 200);
  const alphaWebhookAfter = await request("/api/admin/integrations/staff-webhook", {}, alphaSession);
  const betaWebhookAfter = await request("/api/admin/integrations/staff-webhook", {}, betaSession);
  assert.equal((await alphaWebhookAfter.json()).configured, false, "Hotel Alpha should remove only its own webhook");
  assert.equal((await betaWebhookAfter.json()).configured, true, "Hotel Beta's webhook must remain untouched");

  for (const session of [alphaSession, betaSession]) {
    const onboarding = await request("/api/admin/onboarding", {}, session);
    assert.equal(onboarding.status, 200);
    const state = await onboarding.json();
    assert.equal(state.checks.find((item) => item.key === "handoff").done, false, "a configured endpoint is not verified until its signed test succeeds");
    assert.equal(state.checks.find((item) => item.key === "ai").done, false);
  }

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

  const parallelOverview = await Promise.all(Array.from({ length: 12 }, (_, index) => {
    const isAlpha = index % 2 === 0;
    const session = isAlpha ? alphaSession : betaSession;
    return request("/api/admin/overview", {}, session).then(async (response) => ({
      isAlpha,
      status: response.status,
      body: await response.json()
    }));
  }));
  for (const result of parallelOverview) {
    assert.equal(result.status, 200, "both hotels should serve concurrent dashboard requests");
    assert.equal(result.body.conversations.length, 1);
    const payload = JSON.stringify(result.body);
    assert.ok(payload.includes(result.isAlpha ? "Private Alpha assistant reply" : "Private Beta assistant reply"));
    assert.ok(!payload.includes(result.isAlpha ? "Private Beta assistant reply" : "Private Alpha assistant reply"));
    assert.ok(!payload.includes(result.isAlpha ? "Private Beta guest message" : "Private Alpha guest message"));
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
  const alphaTranscriptBody = await alphaTranscript.text();
  assert.match(alphaTranscriptBody, /Private Alpha guest message/);
  assert.match(alphaTranscriptBody, /Private Alpha assistant reply/);
  assert.doesNotMatch(alphaTranscriptBody, /Private Beta (?:guest message|assistant reply)/);
  const betaTranscript = await request(`/api/admin/conversations/${alphaConversation.rows[0].id}`, {}, betaSession);
  assert.equal(betaTranscript.status, 404);
});
