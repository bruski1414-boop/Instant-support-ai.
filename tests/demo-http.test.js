"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");

let child;
let baseUrl;
let output = "";

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForDemo() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Veyra exited before HTTP tests: " + output);
    try {
      const response = await fetch(baseUrl + "/api/demo/metrics");
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Veyra demo HTTP server did not start: " + output);
}

test("demo HTTP routes return isolated synthetic data and safe handoffs", async t => {
  const port = await unusedPort();
  baseUrl = "http://127.0.0.1:" + port;
  child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      STAFF_WEBHOOK_URL: "",
      STAFF_WEBHOOK_SECRET: "",
      ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });

  t.after(async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitForDemo();

  const page = await fetch(baseUrl + "/demo");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /DEMO ONLY/);

  const metricsResponse = await fetch(baseUrl + "/api/demo/metrics");
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.demoOnly, true);
  assert.equal(metrics.veyraLinkedRevenueMinor, 0);
  assert.match(metrics.note, /not attributed to Veyra/);

  const breakfastResponse = await fetch(baseUrl + "/api/demo/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What time is breakfast?" })
  });
  assert.equal(breakfastResponse.status, 200);
  const breakfast = await breakfastResponse.json();
  assert.equal(breakfast.needsHuman, false);
  assert.match(breakfast.reply, /6:30 AM to 10:30 AM/);

  const handoffResponse = await fetch(baseUrl + "/api/demo/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Can you arrange an airport transfer?" })
  });
  assert.equal(handoffResponse.status, 200);
  const handoff = await handoffResponse.json();
  assert.equal(handoff.needsHuman, true);
  assert.equal(handoff.handoffStatus, "demo_queue_only");
  assert.match(handoff.reply, /none are booked in this demo/i);

  const invalidResponse = await fetch(baseUrl + "/api/demo/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "" })
  });
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /between 1 and 1,200/);
});
