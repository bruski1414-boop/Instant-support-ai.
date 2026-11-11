const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { spawn } = require("node:child_process");
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
  assert.equal(body.humanHandoff, "flag-only-notification-not-configured");
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
