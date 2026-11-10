const test = require("node:test");
const assert = require("node:assert/strict");
const { app, shouldEscalate, safeFallback } = require("./server");

test("sensitive requests are marked for staff review", () => {
  assert.equal(shouldEscalate("I need to cancel my booking"), true);
  assert.equal(shouldEscalate("I have an allergy question"), true);
  assert.equal(shouldEscalate("What time is breakfast?"), false);
});

test("routine hotel FAQs stay eligible for automated handling", () => {
  for (const message of [
    "What time is breakfast?",
    "Is there a swimming pool?",
    "What is the Wi-Fi name?",
    "Where is the gym?",
    "What time is check-in?",
    "Do you have airport transfers?",
    "What attractions are nearby?",
  ]) {
    assert.equal(shouldEscalate(message), false, message);
  }
});

test("consequential, sensitive, and service-failure requests are escalated", () => {
  for (const message of [
    "I want to cancel my reservation",
    "I was charged twice",
    "I lost my passport in the room",
    "Can you help with wheelchair access?",
    "The room has not been cleaned",
    "The air conditioning is broken",
    "I have an allergy",
    "I need a real person",
    "There is a fire",
  ]) {
    assert.equal(shouldEscalate(message), true, message);
  }
});

test("fallback never claims that staff were contacted", () => {
  const result = safeFallback();
  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /can't verify/i);
  assert.doesNotMatch(result.reply, /staff have been notified/i);
});

test("health endpoint reports explicit handoff limitation", async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.service, "Veyra AI");
  assert.equal(typeof body.handoffConfigured, "boolean");
  assert.equal(typeof body.liveAIReady, "boolean");
});

test("chat endpoint rejects empty messages", async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "   " }),
  });
  assert.equal(response.status, 400);
});

test("private configuration and source files are not served", async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const address = server.address();
  for (const file of ["/.env", "/server.js", "/package.json", "/render.yaml"]) {
    const response = await fetch(`http://127.0.0.1:${address.port}${file}`);
    assert.equal(response.status, 404, `${file} should not be publicly served`);
  }
});
