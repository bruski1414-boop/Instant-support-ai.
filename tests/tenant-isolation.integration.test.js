const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const { Pool } = require("pg");

const databaseUrl = process.env.TEST_DATABASE_URL;
test("two hotel workspaces remain isolated across live API resources", { skip: !databaseUrl }, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  let child;
  let baseUrl;
  let webhookServer;
  let webhookUrl;
  const webhookEvents = [];
  const webhookSecret = "integration-test-webhook-secret";
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
    if (webhookServer) await new Promise((resolve) => webhookServer.close(resolve));
    await pool.end();
  });

  webhookServer = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      webhookEvents.push({ payload: JSON.parse(raw), signature: req.headers["x-veyra-signature"] });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  await new Promise((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
  webhookUrl = `http://127.0.0.1:${webhookServer.address().port}/staff-handoff`;

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
      STAFF_WEBHOOK_URL: webhookUrl,
      STAFF_WEBHOOK_SECRET: webhookSecret,
      GUEST_DATA_STORAGE_ENABLED: "true",
      DURABLE_BACKUPS_VERIFIED: "true",
      TENANT_ISOLATION_TESTS_PASSED: "true",
      PROVIDER_OAUTH_TESTED: "true",
      PLATFORM_PRIVACY_REVIEWED: "true",
      RETENTION_ENFORCEMENT_VERIFIED: "true",
      STAFF_HANDOFF_TESTED: "true",
      PILOT_RELEASE_APPROVED: "true",
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
  const betaEscalation = await pool.query(
    "INSERT INTO escalations(organization_id,conversation_id,reason) VALUES($1,$2,'Beta private escalation') RETURNING id",
    [betaId, betaConversation.rows[0].id]
  );
  await pool.query(
    "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type) VALUES($1,$2,'alpha.private_event','test'),($3,$4,'beta.private_event','test')",
    [alphaId, alphaUser.rows[0].id, betaId, betaUser.rows[0].id]
  );
  await pool.query(
    "INSERT INTO storage_connections(organization_id,provider,account_email,encrypted_tokens,status) VALUES($1,'google','storage@alpha.test','encrypted-alpha-placeholder','connected'),($2,'microsoft','storage@beta.test','encrypted-beta-placeholder','connected')",
    [alphaId, betaId]
  );
  await pool.query(
    "INSERT INTO organization_integration_checks(organization_id,integration,verified_by) VALUES($1,'ai_provider',$2),($3,'ai_provider',$4)",
    [alphaId, alphaUser.rows[0].id, betaId, betaUser.rows[0].id]
  );

  const alphaSession = await login("hotel-alpha", "owner@alpha.test");
  const betaSession = await login("hotel-beta", "owner@beta.test");
  const alphaApproval = await request("/api/platform/organizations/hotel-alpha/privacy-approval", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Platform-Provisioning-Token": provisioningToken },
    body: JSON.stringify({ approvalReference: "ALPHA-PRIVACY-APPROVAL-TEST", retentionDays: 90 })
  });
  assert.equal(alphaApproval.status, 201, "platform operator can record one hotel's written approval");
  const unauthorizedBetaApproval = await request("/api/platform/organizations/hotel-beta/privacy-approval", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Platform-Provisioning-Token": "wrong-token" },
    body: JSON.stringify({ approvalReference: "BETA-PRIVACY-APPROVAL-TEST", retentionDays: 90 })
  });
  assert.equal(unauthorizedBetaApproval.status, 403, "hotel privacy approvals cannot be self-issued without the platform operator token");

  for (const [session, ownProvider, otherProvider] of [
    [alphaSession, "google", "microsoft"],
    [betaSession, "microsoft", "google"]
  ]) {
    const onboardingResponse = await request("/api/admin/onboarding", {}, session);
    assert.equal(onboardingResponse.status, 200);
    const onboarding = await onboardingResponse.json();
    const storageCheck = onboarding.checks.find((check) => check.key === "hotel_storage");
    assert.equal(storageCheck.done, true, "the hotel's own connected OAuth account should satisfy storage readiness");
    assert.match(storageCheck.detail, new RegExp(ownProvider));
    assert.doesNotMatch(storageCheck.detail, new RegExp(otherProvider), "another hotel's storage provider must not leak into this workspace");
    const privacyCheck = onboarding.checks.find((check) => check.key === "privacy");
    const isAlpha = session === alphaSession;
    assert.equal(privacyCheck.done, isAlpha, "privacy approval must be recorded separately for each hotel");
    if (isAlpha) assert.match(privacyCheck.detail, /90-day retention target/);
    else assert.match(privacyCheck.detail, /platform operator must record this hotel's written privacy approval/i);
  }


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

  for (const [session, expectedSlug, expectedId] of [
    [alphaSession, "hotel-alpha", alphaId],
    [betaSession, "hotel-beta", betaId]
  ]) {
    const check = await request("/api/admin/integrations/test-staff-webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, session);
    assert.equal(check.status, 200, "each hotel owner should be able to verify the shared signed dispatcher");
    const body = await check.json();
    assert.equal(body.verified, true);
    assert.equal(body.organizationSlug, expectedSlug);
    const event = webhookEvents.at(-1);
    assert.equal(event.payload.event, "veyra.integration.test");
    assert.equal(event.payload.organizationId, expectedId);
    assert.equal(event.payload.organizationSlug, expectedSlug);
    assert.equal(event.payload.test, true);
    assert.equal(event.signature, crypto.createHmac("sha256", webhookSecret).update(JSON.stringify(event.payload)).digest("hex"));
  }
  const verifiedChecks = await pool.query("SELECT organization_id,integration FROM organization_integration_checks WHERE integration='staff_webhook' ORDER BY organization_id");
  assert.equal(verifiedChecks.rowCount, 2, "staff integration verification must be stored separately for each hotel");

  for (const session of [alphaSession, betaSession]) {
    const onboarding = await request("/api/admin/onboarding", {}, session);
    assert.equal(onboarding.status, 200);
    const state = await onboarding.json();
    assert.equal(state.checks.find((item) => item.key === "handoff").done, true);
    assert.equal(state.checks.find((item) => item.key === "ai").done, false);
  }

  for (const [session, escalationId, expectedOrganizationId, expectedSlug] of [
    [alphaSession, alphaEscalation.rows[0].id, alphaId, "hotel-alpha"],
    [betaSession, betaEscalation.rows[0].id, betaId, "hotel-beta"]
  ]) {
    const response = await request(`/api/admin/escalations/${escalationId}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }, session);
    assert.equal(response.status, 200, "each hotel should be able to retry its own staff handoff");
    const body = await response.json();
    assert.equal(body.delivered, true);
    assert.equal(body.notificationStatus, "delivered");
    const event = webhookEvents.at(-1);
    assert.equal(event.payload.organizationId, expectedOrganizationId);
    assert.equal(event.payload.organizationSlug, expectedSlug);
    assert.equal(event.payload.event, "veyra.escalation.created");
    assert.equal(
      event.signature,
      crypto.createHmac("sha256", webhookSecret).update(JSON.stringify(event.payload)).digest("hex"),
      "handoff webhook must be signed"
    );
  }

  const alphaRetryState = await pool.query("SELECT notification_status,notification_attempts FROM escalations WHERE id=$1", [alphaEscalation.rows[0].id]);
  const betaRetryState = await pool.query("SELECT notification_status,notification_attempts FROM escalations WHERE id=$1", [betaEscalation.rows[0].id]);
  assert.deepEqual(alphaRetryState.rows[0], { notification_status: "delivered", notification_attempts: 1 });
  assert.deepEqual(betaRetryState.rows[0], { notification_status: "delivered", notification_attempts: 1 });
  assert.equal(webhookEvents.length, 4, "each hotel's test event and escalation should reach the dispatcher exactly once");

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
    assert.ok(payload.includes(result.isAlpha ? "Private Alpha guest message" : "Private Beta guest message"));
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
  assert.match((await alphaTranscript.text()), /Private Alpha guest message/);
  const betaTranscript = await request(`/api/admin/conversations/${alphaConversation.rows[0].id}`, {}, betaSession);
  assert.equal(betaTranscript.status, 404);
  if (child && child.exitCode === null) {
    const originalChild = child;
    originalChild.kill("SIGTERM");
    await new Promise((resolve) => originalChild.once("exit", resolve));
  }
  const privacyPort = await freePort();
  baseUrl = `http://127.0.0.1:${privacyPort}`;
  child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(privacyPort),
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: "false",
      OPENAI_API_KEY: "synthetic-integration-test-key",
      BOOTSTRAP_TOKEN: bootstrapToken,
      PLATFORM_PROVISIONING_TOKEN: provisioningToken,
      STAFF_WEBHOOK_URL: webhookUrl,
      STAFF_WEBHOOK_SECRET: webhookSecret,
      GUEST_DATA_STORAGE_ENABLED: "true",
      DURABLE_BACKUPS_VERIFIED: "true",
      TENANT_ISOLATION_TESTS_PASSED: "true",
      PROVIDER_OAUTH_TESTED: "true",
      PLATFORM_PRIVACY_REVIEWED: "true",
      RETENTION_ENFORCEMENT_VERIFIED: "true",
      STAFF_HANDOFF_TESTED: "true",
      PILOT_RELEASE_APPROVED: "true",
      ALLOWED_ORIGINS: "http://localhost:3000"
    },
    stdio: "ignore"
  });
  let privacyServerReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Privacy-gate test server exited during startup");
    try {
      const response = await fetch(baseUrl + "/api/health");
      if (response.ok) { privacyServerReady = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(privacyServerReady, "privacy-gate test server should start with synthetic platform approvals");

  const betaGuestChat = await request("/api/public/hotel-beta/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What time is breakfast?" })
  });
  assert.equal(betaGuestChat.status, 503);
  assert.match((await betaGuestChat.json()).error, /privacy and retention approval/i, "a different hotel's approval must not unlock Beta guest chat");

  await pool.query("DELETE FROM knowledge_documents WHERE organization_id=$1", [alphaId]);
  const alphaGuestChat = await request("/api/public/hotel-alpha/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What time is breakfast?" })
  });
  assert.equal(alphaGuestChat.status, 503);
  assert.match((await alphaGuestChat.json()).error, /No hotel information has been approved/i, "Alpha should pass its own privacy gate and stop at the next missing prerequisite");
  const unauthorizedRevoke = await request("/api/platform/organizations/hotel-alpha/privacy-approval", {
    method: "DELETE",
    headers: { "X-Platform-Provisioning-Token": "wrong-token" }
  });
  assert.equal(unauthorizedRevoke.status, 403, "a hotel approval cannot be revoked without the platform operator token");
  const revokeAlpha = await request("/api/platform/organizations/hotel-alpha/privacy-approval", {
    method: "DELETE",
    headers: { "X-Platform-Provisioning-Token": provisioningToken }
  });
  assert.equal(revokeAlpha.status, 200);
  const alphaAfterRevoke = await request("/api/admin/onboarding", {}, alphaSession);
  const alphaPrivacyAfterRevoke = (await alphaAfterRevoke.json()).checks.find((check) => check.key === "privacy");
  assert.equal(alphaPrivacyAfterRevoke.done, false, "revoking approval must close that hotel's privacy gate again");
});
