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
  assert.match(server, /typeof body\.approved!=="boolean"/);
  assert.match(server, /body\.content\.length>12000/);
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

test("guest conversation writes lock and revalidate the tenant-owned conversation before appending messages", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /SELECT id FROM conversations WHERE id=\$1 AND organization_id=\$2 AND guest_token_hash=\$3 FOR UPDATE/);
  assert.match(server, /UPDATE conversations SET last_message_at=now\(\),status=CASE WHEN \$2 THEN 'escalated' WHEN status='resolved' THEN 'open' ELSE status END WHERE id=\$1 AND organization_id=\$3/);
});
