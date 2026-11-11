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
  const modelRequests = [];
  const webhookSecret = "integration-test-webhook-secret";
  const password = "test-password-for-hotel-owner";
  let openAiServer;
  let openAiBaseUrl;
  let failNextModelRequest = false;

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
    if (openAiServer) await new Promise((resolve) => openAiServer.close(resolve));
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

  openAiServer = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      modelRequests.push(JSON.parse(raw));
      if (failNextModelRequest) {
        failNextModelRequest = false;
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Synthetic provider outage", type: "authentication_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-synthetic",
        object: "chat.completion",
        created: 1,
        model: "gpt-4.1-mini",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({ reply: "Breakfast is served at 7am.", needsHuman: false, handoffReason: "" })
          },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }));
    });
  });
  await new Promise((resolve) => openAiServer.listen(0, "127.0.0.1", resolve));
  openAiBaseUrl = `http://127.0.0.1:${openAiServer.address().port}/v1`;

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
      RETENTION_ENFORCEMENT_VERIFIED: "false",
      RETENTION_WORKER_ENABLED: "false",
      STAFF_HANDOFF_TESTED: "true",
      PILOT_RELEASE_APPROVED: "true",
      // Deliberately include both hotel domains: the public guest API must still enforce the matching tenant's saved website origin.
      ALLOWED_ORIGINS: "https://alpha.test,https://beta.test,http://localhost:3000"
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
    "INSERT INTO organization_settings(organization_id,website_url,support_email,language,fallback_instructions) VALUES($1,'https://alpha.test','alpha@alpha.test','th','Use the Alpha front desk only.'),($2,'https://beta.test','beta@beta.test','fr','Use the Beta reception only.')",
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

  const invalidKnowledgeApproval = await request("/api/admin/knowledge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Unverified input type", content: "This should not be saved as approved knowledge.", approved: "false" })
  }, alphaSession);
  assert.equal(invalidKnowledgeApproval.status, 400, "a string value such as 'false' must not be coerced into approved=true");
  assert.match((await invalidKnowledgeApproval.json()).error, /Approval must be a boolean/i);
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
    assert.equal(onboarding.platformReady, false, "missing live AI configuration must keep the platform release gate closed");
    assert.equal(onboarding.readyForPilot, false, "hotel checks alone must not mark the pilot ready");
    const storageCheck = onboarding.checks.find((check) => check.key === "hotel_storage");
    assert.equal(storageCheck.done, false, "an OAuth token without a successful file listing must not satisfy storage readiness");
    assert.match(storageCheck.detail, /successful file listing is required/i);
    assert.match(storageCheck.detail, new RegExp(ownProvider));
    assert.doesNotMatch(storageCheck.detail, new RegExp(otherProvider), "another hotel's storage provider must not leak into this workspace");
    const privacyCheck = onboarding.checks.find((check) => check.key === "privacy");
    const isAlpha = session === alphaSession;
    assert.equal(privacyCheck.done, false, "the first server has no verified retention worker");
    if (isAlpha) assert.match(privacyCheck.detail, /retention worker has not completed a recent successful run/i);
    else assert.match(privacyCheck.detail, /platform operator must record this hotel's written privacy approval/i);
  }

  await pool.query("UPDATE storage_connections SET last_sync_at=now(),last_error=NULL WHERE organization_id IN ($1,$2)", [alphaId, betaId]);
  for (const [session, ownProvider, otherProvider] of [
    [alphaSession, "google", "microsoft"],
    [betaSession, "microsoft", "google"]
  ]) {
    const onboarding = await request("/api/admin/onboarding", {}, session);
    assert.equal(onboarding.status, 200);
    const state = await onboarding.json();
    const storageCheck = state.checks.find((check) => check.key === "hotel_storage");
    assert.equal(storageCheck.done, true, "a recent successful file listing should verify only the hotel's own storage connection");
    assert.match(storageCheck.detail, new RegExp(ownProvider));
    assert.doesNotMatch(storageCheck.detail, new RegExp(otherProvider));
  }


  const normalizedAlphaSettings = await request("/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ website_url: "https://alpha.test/", support_email: "alpha@alpha.test", timezone: "UTC", language: "th", fallback_instructions: "Use the Alpha front desk only." })
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
  await pool.query("UPDATE organization_privacy_approvals SET retention_days=1 WHERE organization_id=$1", [alphaId]);
  const oldAlphaConversation = await pool.query(
    "INSERT INTO conversations(organization_id,channel,status,started_at,last_message_at) VALUES($1,'website','open',now()-interval '2 days',now()-interval '2 days') RETURNING id",
    [alphaId]
  );
  const oldBetaConversation = await pool.query(
    "INSERT INTO conversations(organization_id,channel,status,started_at,last_message_at) VALUES($1,'website','open',now()-interval '2 days',now()-interval '2 days') RETURNING id",
    [betaId]
  );
  await pool.query(
    "INSERT INTO messages(conversation_id,role,content,created_at) VALUES($1,'guest','expired Alpha test message',now()-interval '2 days'),($2,'guest','unapproved Beta test message',now()-interval '2 days')",
    [oldAlphaConversation.rows[0].id, oldBetaConversation.rows[0].id]
  );

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
      OPENAI_BASE_URL: openAiBaseUrl,
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
      RETENTION_WORKER_ENABLED: "true",
      STAFF_HANDOFF_TESTED: "true",
      PILOT_RELEASE_APPROVED: "true",
      // Deliberately include both hotel domains: the public guest API must still enforce the matching tenant's saved website origin.
      ALLOWED_ORIGINS: "https://alpha.test,https://beta.test,http://localhost:3000"
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
  let retentionRunReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await pool.query("SELECT last_success_at,last_deleted_conversations FROM retention_purge_runs WHERE organization_id=$1", [alphaId]);
    if (run.rowCount && run.rows[0].last_success_at) {
      retentionRunReady = true;
      assert.equal(run.rows[0].last_deleted_conversations, 1, "the worker should delete the expired Alpha conversation");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(retentionRunReady, "the scheduled retention worker should complete a per-hotel purge");
  const expiredAlpha = await pool.query("SELECT id FROM conversations WHERE id=$1", [oldAlphaConversation.rows[0].id]);
  const retainedBeta = await pool.query("SELECT id FROM conversations WHERE id=$1", [oldBetaConversation.rows[0].id]);
  const expiredAlphaMessages = await pool.query("SELECT id FROM messages WHERE conversation_id=$1", [oldAlphaConversation.rows[0].id]);
  const retainedBetaMessages = await pool.query("SELECT id FROM messages WHERE conversation_id=$1", [oldBetaConversation.rows[0].id]);
  assert.equal(expiredAlpha.rowCount, 0, "Alpha's approved retention policy should delete expired conversation data");
  assert.equal(expiredAlphaMessages.rowCount, 0, "conversation deletion should cascade to guest messages");
  assert.equal(retainedBeta.rowCount, 1, "Alpha's approval must not purge Beta's data");
  assert.equal(retainedBetaMessages.rowCount, 1, "Beta's messages must remain scoped to Beta");

  await pool.query("UPDATE storage_connections SET last_sync_at=NULL WHERE organization_id=$1", [alphaId]);
  const alphaStorageUnverifiedChat = await request("/api/public/hotel-alpha/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What time is breakfast?" })
  });
  assert.equal(alphaStorageUnverifiedChat.status, 503);
  assert.match((await alphaStorageUnverifiedChat.json()).error, /successful storage file listing within the last 30 days/i);
  await pool.query("UPDATE storage_connections SET last_sync_at=now(),last_error=NULL WHERE organization_id=$1", [alphaId]);

  const alphaReadyResponse = await request("/api/admin/onboarding", {}, alphaSession);
  const alphaReady = await alphaReadyResponse.json();
  assert.equal(alphaReady.platformReady, true);
  assert.equal(alphaReady.readyForPilot, true, "Alpha should pass both platform and hotel-specific checks when all synthetic gates are satisfied");
  const betaReadyResponse = await request("/api/admin/onboarding", {}, betaSession);
  const betaReady = await betaReadyResponse.json();
  assert.equal(betaReady.platformReady, true);
  assert.equal(betaReady.readyForPilot, false, "Beta must remain blocked by its own missing privacy approval");

  const betaGuestChat = await request("/api/public/hotel-beta/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What time is breakfast?" })
  });
  assert.equal(betaGuestChat.status, 503);
  assert.match((await betaGuestChat.json()).error, /privacy and retention approval/i, "a different hotel's approval must not unlock Beta guest chat");

  const alphaGuestChat = await request("/api/public/hotel-alpha/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What time is breakfast?" })
  });
  assert.equal(alphaGuestChat.status, 200, "Alpha can use its own verified configuration and approved knowledge: " + await alphaGuestChat.clone().text());
  const alphaGuestBody = await alphaGuestChat.json();
  assert.equal(alphaGuestBody.reply, "Breakfast is served at 7am.");
  assert.equal(alphaGuestBody.needsHuman, false);
  const alphaSystemPrompt = modelRequests.at(-1).messages.find((message) => message.role === "system").content;
  assert.match(alphaSystemPrompt, /Preferred reply language: "th"/);
  assert.match(alphaSystemPrompt, /alpha@alpha\.test/);
  assert.match(alphaSystemPrompt, /Use the Alpha front desk only/);
  assert.match(alphaSystemPrompt, /Alpha serves breakfast at 7am\./);
  assert.doesNotMatch(alphaSystemPrompt, /Beta|beta@beta\.test/);

  failNextModelRequest = true;
  const providerFailure = await request("/api/public/hotel-alpha/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Could you help with a technical issue?" })
  });
  assert.equal(providerFailure.status, 200, "an AI provider outage should produce a safe fallback and staff escalation");
  const providerFailureBody = await providerFailure.json();
  assert.equal(providerFailureBody.reply, "I cannot prepare a reliable answer right now. Please contact hotel staff.");
  assert.equal(providerFailureBody.needsHuman, true);
  assert.equal(providerFailureBody.notificationDelivered, true);
  assert.equal(providerFailureBody.notificationStatus, "delivered");
  assert.ok(providerFailureBody.escalationId);
  const providerFailureEvent = webhookEvents.at(-1);
  assert.equal(providerFailureEvent.payload.organizationId, alphaId);
  assert.equal(providerFailureEvent.payload.organizationSlug, "hotel-alpha");
  assert.match(providerFailureEvent.payload.reason, /Live AI is temporarily unavailable/);
  assert.equal(providerFailureEvent.signature, crypto.createHmac("sha256", webhookSecret).update(JSON.stringify(providerFailureEvent.payload)).digest("hex"));
  const persistedProviderFailure = await pool.query("SELECT notification_status,notification_attempts FROM escalations WHERE id=$1", [providerFailureBody.escalationId]);
  assert.deepEqual(persistedProviderFailure.rows[0], { notification_status: "delivered", notification_attempts: 1 });

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
  const retainedApproval = await pool.query("SELECT revoked_at FROM organization_privacy_approvals WHERE organization_id=$1", [alphaId]);
  const retainedPurgeRun = await pool.query("SELECT last_success_at FROM retention_purge_runs WHERE organization_id=$1", [alphaId]);
  assert.equal(retainedApproval.rowCount, 1, "revocation must preserve the retention schedule for existing data");
  assert.ok(retainedApproval.rows[0].revoked_at);
  assert.equal(retainedPurgeRun.rowCount, 1, "retention monitoring must continue after guest-chat approval is revoked");
});
