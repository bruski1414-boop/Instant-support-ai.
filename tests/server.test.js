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
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Veyra server did not become ready");
});
after(() => { if (child && child.exitCode === null) child.kill("SIGTERM"); });
test("health endpoint reports demo mode when no API key is configured", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.mode, "demo-no-api-key");
  assert.equal(body.humanHandoff, "not-configured");
  assert.equal(body.database, "not-configured");
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
  assert.match(widget, /conversationId=data\.conversationId\|\|conversationId/);
  assert.match(server, /WHERE id=\$1 AND organization_id=\$2/);
  assert.match(server, /LIMIT 8/);
});
