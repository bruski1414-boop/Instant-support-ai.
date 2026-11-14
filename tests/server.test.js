const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const vm = require("node:vm");
let child;
let baseUrl;
async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
before(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "", ALLOWED_ORIGINS: "http://localhost:3000" }, stdio: "ignore" });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Veyra server exited before tests started");
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok || response.status === 503) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Veyra server did not become ready");
});
after(() => { if (child && child.exitCode === null) child.kill("SIGTERM"); });
test("health endpoint reports demo mode when no API key is configured", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.readyForPilot, false);
  assert.equal(body.checks.databaseConnected, false);
  assert.equal(body.checks.aiConfigured, false);
  assert.equal(body.mode, "demo-no-api-key");
  assert.equal(body.humanHandoff, "not-configured");
  assert.equal(body.guestDataStorage, false);
  assert.equal(body.database, "not-configured");
});
test("pilot readiness remains blocked separately from process health", async () => {
  const response = await fetch(`${baseUrl}/api/readiness`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.status, "not-ready");
  assert.equal(body.readyForPilot, false);
});
test("chat rejects an empty message", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "   " }) });
  assert.equal(response.status, 400);
});
test("chat rejects malformed conversation history", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hello", history: "not-an-array" }) });
  assert.equal(response.status, 400);
});
test("chat rejects messages above the documented size limit", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "x".repeat(4001) }) });
  assert.equal(response.status, 413);
});
test("chat does not pretend to be live when the provider key is missing", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "What time is breakfast?" }) });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.demo, true);
  assert.equal(body.handoffConfigured, false);
});

test("dashboard and guest widget JavaScript parse cleanly", () => {
  const html = fs.readFileSync("dashboard.html", "utf8");
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "dashboard inline script exists");
  new vm.Script(html.slice(start + 8, end));
  new vm.Script(fs.readFileSync("widget.js", "utf8"));
});
test("tenant chat fails closed when database is not configured", async () => {
  const response = await fetch(`${baseUrl}/api/public/sample-hotel/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What time is breakfast?" })
  });
  assert.equal(response.status, 503);
});

test("organization bootstrap fails closed when database is not configured", async () => {
  const response = await fetch(`${baseUrl}/api/setup/organization`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationName: "Sample Hotel", email: "owner@example.com", password: "a-long-test-password" })
  });
  assert.equal(response.status, 503);
});

test("public hotel chat has a dedicated abuse limit", async () => {
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = await fetch(`${baseUrl}/api/public/sample-hotel/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What time is breakfast?" })
    });
  }
  assert.equal(last.status, 429);
});

test("initial workspace bootstrap has a dedicated attempt limit", async () => {
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await fetch(`${baseUrl}/api/setup/organization`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationName: "Sample Hotel", email: "owner@example.com", password: "a-long-test-password" })
    });
  }
  assert.equal(last.status, 429);
});

test("guest widget reuses its server-issued conversation id", () => {
  const widget = fs.readFileSync("widget.js", "utf8");
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(widget, /conversationId:conversationId/);
  assert.match(widget, /conversationToken:conversationToken/);
  assert.match(server, /guest_token_hash=\$3/);
  assert.match(server, /hash\(requestedToken\)/);
  assert.match(widget, /conversationId=data\.conversationId\|\|conversationId/);
  assert.match(server, /WHERE id=\$1 AND organization_id=\$2/);
  assert.match(server, /LIMIT 8/);
  assert.match(server, /requestedConversation!==null/);
});

test("conversation deletion fails closed without a database", async () => {
  const response = await fetch(`${baseUrl}/api/admin/conversations/123e4567-e89b-42d3-a456-426614174000`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(response.status, 503);
});

test("conversation deletion is tenant scoped and owner controlled", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /app\.delete\("\/api\/admin\/conversations\/:id",requireDb,auth,role\("owner","admin"\)/);
  assert.match(server, /DELETE FROM conversations WHERE id=\$1 AND organization_id=\$2/);
  assert.match(server, /conversation\.deleted/);
  assert.match(dashboard, /delete-conversation/);
});

test("conversation transcript endpoint fails closed without a database", async () => {
  const response = await fetch(`${baseUrl}/api/admin/conversations/123e4567-e89b-42d3-a456-426614174000`);
  assert.equal(response.status, 503);
});

test("conversation transcript reads are tenant scoped", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /app\.get\("\/api\/admin\/conversations\/:id",requireDb,auth/);
  assert.match(server, /SELECT id,status,channel,started_at,last_message_at FROM conversations WHERE id=\$1 AND organization_id=\$2/);
  assert.match(server, /messages:m\.rows\.reverse\(\)/);
  assert.match(dashboard, /view-conversation/);
});

test("public file serving exposes only the intended frontend assets", async () => {
  const widget = await fetch(`${baseUrl}/widget.js`);
  const source = await fetch(`${baseUrl}/server.js`);
  const docs = await fetch(`${baseUrl}/README.md`);
  assert.equal(widget.status, 200);
  assert.equal(source.status, 404);
  assert.equal(docs.status, 404);
  assert.equal(widget.headers.get("x-content-type-options"), "nosniff");
  assert.equal(widget.headers.get("x-frame-options"), "DENY");
});

test("sign-in is scoped to a hotel workspace", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /organizationSlug/);
  assert.match(server, /JOIN organizations o ON o\.id=u\.organization_id/);
  assert.match(server, /o\.slug=\$2/);
  assert.match(dashboard, /id="workspaceSlug"/);
});

test("first-owner bootstrap serializes competing setup requests", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /pg_advisory_xact_lock\(20261111\)/);
});

test("editing approved hotel knowledge requires reapproval", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /contentChanged\?false:Boolean\(v\.approved\)/);
  assert.match(server, /knowledge\.edited_unapproved/);
  assert.match(server, /isOptionalBoolean\(body\.approved\)/);
  assert.match(server, /body\.content\.length>12000/);
});


test("retention policy is tenant-controlled, disabled by default and requires explicit cleanup confirmation", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /conversation_retention_days INTEGER NOT NULL DEFAULT 0/);
  assert.match(server, /app\.put\("\/api\/admin\/retention",requireDb,auth,role\("owner","admin"\)/);
  assert.match(server, /app\.post\("\/api\/admin\/retention\/cleanup",requireDb,auth,role\("owner","admin"\)/);
  assert.match(server, /q\.body\?\.confirm!==true/);
  assert.match(server, /c\.status='resolved'/);
  assert.match(server, /e\.status<>'resolved'/);
  assert.match(dashboard, /id="retentionDays"/);
  assert.match(dashboard, /id="runRetention"/);
  assert.match(dashboard, /Permanently delete eligible resolved conversations/);
});

test("health endpoint cannot report pilot readiness with missing prerequisites", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(body.readyForPilot, false);
  assert.deepEqual(body.checks, {
    databaseConnected: false,
    aiConfigured: false,
    guestDataStorageEnabled: false,
    staffWebhookConfigured: false,
    durableBackupsVerified: false,
    tenantIsolationTestsPassed: false,
    providerOAuthTested: false,
    hotelPrivacyApproved: false,
    staffHandoffTested: false,
    pilotReleaseApproved: false,
  });
});

test("knowledge documents retain tenant-scoped version history", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /CREATE TABLE IF NOT EXISTS knowledge_document_versions/);
  assert.match(server, /knowledge_document_versions WHERE document_id=\$1 AND organization_id=\$2/);
  assert.match(server, /change_type/);
  assert.match(dashboard, /history-knowledge/);
  assert.match(dashboard, /knowledgeHistory/);
});

test("hotel policy text import loads a limited browser-side unapproved draft", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /id="kImportFile" type="file" accept="\.txt,\.md,text\/plain,text\/markdown"/);
  assert.match(dashboard, /file\.size>12000/);
  assert.match(dashboard, /content\.length>12000/);
  assert.match(dashboard, /\$\("kApproved"\)\.checked=false/);
  assert.match(dashboard, /\$\("kCategory"\)\.value="general"/);
  assert.match(dashboard, /Loaded as an unapproved draft/);
  assert.match(dashboard, /Imported draft:/);
});

test("knowledge approval cannot use an expired review date and overdue documents require a new review date", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /SELECT \$1::date < CURRENT_DATE AS past/);
  assert.match(server, /An approved document needs a review date today or later/);
  assert.match(dashboard, /review due soon/);
  assert.match(dashboard, /Last reviewed/);
  assert.match(dashboard, /Enter its next review date/);
  assert.match(dashboard, /payload\.review_due_at=nextReview/);
});

test("guest conversation writes lock and revalidate the tenant-owned conversation before appending messages", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /SELECT id FROM conversations WHERE id=\$1 AND organization_id=\$2 AND guest_token_hash=\$3 FOR UPDATE/);
  assert.match(server, /UPDATE conversations SET last_message_at=now\(\),status=CASE WHEN \$2 THEN 'escalated' WHEN status='resolved' THEN 'open' ELSE status END WHERE id=\$1 AND organization_id=\$3/);
});


test("staff handoff events carry stable tenant identifiers for multi-hotel routing", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const notifications = fs.readFileSync("staff-notifications.js", "utf8");
  assert.match(notifications, /organizationId: organization\.id/);
  assert.match(notifications, /organizationSlug: organization\.slug/);
  assert.match(server, /o\.id AS organization_id,o\.name,o\.slug FROM escalations e JOIN organizations o ON o\.id=e\.organization_id/);
  assert.match(server, /notify\(\{id:item\.organization_id,name:item\.name,slug:item\.slug\}/);
});

test("failed staff notifications are retried at most twice after the initial attempt and visible to staff", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const notifications = fs.readFileSync("staff-notifications.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /notification_status,notification_attempts FROM escalations/);
  assert.match(server, /shouldRetryStaffNotification\(/);
  assert.match(server, /notification_attempts=notification_attempts\+CASE WHEN \$2 THEN 1 ELSE 0 END/);
  assert.match(notifications, /Number\(notificationAttempts\) < 3/);
  assert.match(dashboard, /Attempts: .*notification_attempts/);
  assert.match(dashboard, /notification_last_attempt_at/);
  assert.match(dashboard, /Number\(x\.notification_attempts\|\|0\)<5/);
});


test("hotel website origins are allowed dynamically from each tenant's saved HTTPS profile", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /JOIN organization_settings s ON s\.organization_id=o\.id WHERE o\.slug=\$1 AND s\.website_url=\$2/);
  assert.match(server, /u\.protocol==="https:"&&u\.origin===p\.website_url/);
});

test("public guest chat requires fresh tenant-specific AI, staff and storage verification", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /verified_at>now\(\)-interval '30 days'/);
  assert.match(server, /verifiedForHotel\.has\("ai_provider"\)/);
  assert.match(server, /verifiedForHotel\.has\("staff_webhook"\)/);
  assert.match(server, /FROM organization_storage_connections WHERE organization_id=\$1 AND status='connected'/);
  assert.match(server, /This hotel's AI and staff notification integrations must be verified/);
  assert.match(server, /This hotel must connect and authorize its own storage provider/);
});

test("AI and staff integrations require live verification before onboarding marks them complete", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /organization_integration_checks/);
  assert.match(server, /ai\.models\.retrieve\(MODEL/);
  assert.match(server, /veyra\.integration\.test/);
  assert.match(server, /verified_at,verified_by/);
  assert.match(server, /handoffVerified=Boolean\(handoffConfigured&&verified\.staff_webhook\)/);
});


test("hotel setup dashboard exposes AI and staff dispatcher verification actions", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /id="testAiIntegration"/);
  assert.match(dashboard, /id="testStaffIntegration"/);
  assert.match(dashboard, /api\("\/api\/admin\/integrations\/test-/);
  assert.match(dashboard, /Signed test event accepted for this hotel/);
});


test("hotel profile email validation accepts ordinary staff email addresses", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.ok(server.includes(String.raw`if(email&&!/^[-.+\w]+@[-.\w]+\.[A-Za-z]{2,}$/.test(email))`));
});


test("provider import purge requires explicit confirmation and deletes only this hotel's provider-sourced knowledge and versions", () => {
  const storage = fs.readFileSync("storage-integrations.js", "utf8");
  assert.match(storage, /router\.delete\("\/imports\/:provider", auth, role\("owner", "admin"\)/);
  assert.match(storage, /req\.body\?\.confirm !== true/);
  assert.match(storage, /WHERE organization_id=\$1 AND source_reference LIKE \$2 FOR UPDATE/);
  assert.match(storage, /DELETE FROM knowledge_document_versions WHERE organization_id=\$1 AND document_id=ANY\(\$2::uuid\[\]\)/);
  assert.match(storage, /DELETE FROM knowledge_documents WHERE organization_id=\$1 AND id=ANY\(\$2::uuid\[\]\)/);
  assert.match(storage, /storage\." \+ provider \+ "\.imported_copies_purged/);
});


test("hotel storage dashboard distinguishes disconnect from explicit imported-copy deletion", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /data-storage-purge="google"/);
  assert.match(dashboard, /data-storage-purge="microsoft"/);
  assert.match(dashboard, /PERMANENTLY delete this hotel's imported/);
  assert.match(dashboard, /api\("\/api\/admin\/storage\/imports\/"\+b\.dataset\.storagePurge/);
  assert.match(dashboard, /Existing imported knowledge copies will remain in Veyra until separately deleted/);
});


test("demo metrics HTTP endpoint returns clearly labelled synthetic metrics", async () => {
  const response = await fetch(`${baseUrl}/api/demo/metrics`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.demoOnly, true);
  assert.equal(body.conversations, 126);
  assert.equal(body.resolvedWithoutStaff + body.staffHandoffs, body.conversations);
  assert.equal(body.veyraLinkedRevenueMinor, 0);
  assert.match(body.note, /not attributed to Veyra/);
});

test("demo chat HTTP endpoint answers approved hotel facts", async () => {
  const response = await fetch(`${baseUrl}/api/demo/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "When is breakfast served?" })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.reply, /6:30 AM to 10:30 AM/);
  assert.equal(body.needsHuman, false);
  assert.equal(body.demoOnly, true);
});

test("demo chat HTTP endpoint safely hands booking actions to the simulated queue", async () => {
  const response = await fetch(`${baseUrl}/api/demo/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Can you book me a room?" })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.needsHuman, true);
  assert.equal(body.handoffStatus, "demo_queue_only");
  assert.match(body.reply, /no real staff member is notified/i);
});

test("demo chat HTTP endpoint rejects empty and oversized messages", async () => {
  for (const message of ["", "x".repeat(1201)]) {
    const response = await fetch(`${baseUrl}/api/demo/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /1,200 characters/);
  }
});


test("unmatched approved knowledge triggers a staff escalation instead of an AI guess", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /if\(!retrieval\.matched\)\s*\{\s*answer=\{reply:/);
  assert.match(server, /No relevant approved hotel knowledge matched the guest question/);
  assert.match(server, /needsHuman:true/);
});


test("unsupported numeric AI claims are replaced with a staff-confirmation handoff", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /validateAnswerGrounding\(answer\.reply,retrieval\.groundingText/);
  assert.match(server, /Generated answer contained unsupported numeric details/);
  assert.match(server, /I can’t confidently verify every detail in that answer/);
  assert.match(server, /answer\.needsHuman=true/);
});


test("conversation evidence is tenant-scoped and exposes approved source provenance to managers", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS evidence JSONB/);
  assert.match(server, /UPDATE messages SET evidence=\$1::jsonb WHERE id=\$2 AND role='assistant'/);
  assert.match(server, /SELECT m\.id,m\.role,m\.content,m\.evidence,m\.created_at FROM messages m JOIN conversations c/);
  assert.match(server, /c\.organization_id=\$2/);
  assert.match(dashboard, /function renderConversationMessage\(m\)/);
  assert.match(dashboard, /Approved knowledge sources/);
  assert.match(dashboard, /Last reviewed:/);
  assert.match(dashboard, /Staff handoff:/);
});
