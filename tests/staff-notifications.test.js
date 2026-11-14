"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { deliverStaffEscalation, shouldRetryStaffNotification, encryptSecret, decryptSecret, validateWebhookUrl } = require("../staff-notifications");

const input = {
  organization: { id: "org-1", slug: "aster-house", name: "Aster House" },
  conversationId: "conversation-1",
  reason: "Guest requested staff assistance.",
  idempotencyKey: "escalation-123",
  webhookUrl: "https://hotel.example.test/veyra",
  webhookSecret: "test-only-secret"
};

test("staff escalation is explicitly not configured when webhook credentials are absent", async () => {
  const result = await deliverStaffEscalation({ ...input, webhookUrl: "", webhookSecret: "" });
  assert.deepEqual(result, { configured: false, delivered: false, status: "not_configured" });
});

test("staff escalation sends a signed event and reports successful delivery", async () => {
  let request;
  const result = await deliverStaffEscalation({
    ...input,
    fetchImpl: async (url, options) => { request = { url, ...options }; return { ok: true, status: 200 }; }
  });
  assert.equal(result.status, "delivered");
  assert.equal(result.delivered, true);
  assert.equal(request.url, input.webhookUrl);
  assert.equal(request.method, "POST");
  const expected = crypto.createHmac("sha256", input.webhookSecret).update(request.body).digest("hex");
  assert.equal(request.headers["x-veyra-signature"], expected);
  assert.equal(request.headers["idempotency-key"], input.idempotencyKey);
  const payload = JSON.parse(request.body);
  assert.equal(payload.event, "veyra.escalation.created");
  assert.equal(payload.conversationId, input.conversationId);
  assert.equal(payload.reason, input.reason);
  assert.equal(payload.idempotencyKey, input.idempotencyKey);
});

test("non-success webhook responses are reported as failed delivery", async () => {
  const result = await deliverStaffEscalation({ ...input, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.deepEqual(result, { configured: true, delivered: false, status: "failed" });
});

test("network errors are reported as failed delivery without leaking error details", async () => {
  const result = await deliverStaffEscalation({ ...input, fetchImpl: async () => { throw new Error("private endpoint details"); } });
  assert.deepEqual(result, { configured: true, delivered: false, status: "failed" });
});

test("failed staff notifications retry only while an escalation is open and attempts remain", () => {
  for (const attempts of [0, 1, 2]) {
    assert.equal(shouldRetryStaffNotification({
      needsHuman: true, createdEscalation: false, notificationStatus: "failed", notificationAttempts: attempts
    }), true);
  }
  assert.equal(shouldRetryStaffNotification({
    needsHuman: true, createdEscalation: false, notificationStatus: "failed", notificationAttempts: 3
  }), false);
  assert.equal(shouldRetryStaffNotification({
    needsHuman: true, createdEscalation: false, notificationStatus: "delivered", notificationAttempts: 1
  }), false);
  assert.equal(shouldRetryStaffNotification({
    needsHuman: false, createdEscalation: false, notificationStatus: "failed", notificationAttempts: 1
  }), false);
  assert.equal(shouldRetryStaffNotification({
    needsHuman: true, createdEscalation: true, notificationStatus: "not_configured", notificationAttempts: 0
  }), false);
});

test("hotel webhook secrets are encrypted and authenticated on decrypt", () => {
  const secret = "a-long-random-hotel-webhook-secret-value";
  const key = "test-encryption-key-with-more-than-32-characters";
  const encrypted = encryptSecret(secret, key);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptSecret(encrypted, key), secret);
  assert.throws(() => decryptSecret(encrypted, "a-different-key-with-more-than-32-characters"));
});

test("hotel webhook URL validation requires public HTTPS destinations", () => {
  assert.equal(validateWebhookUrl("https://hooks.hotel.com/events"), "https://hooks.hotel.example/events");
  for (const url of [
    "http://hooks.hotel.example/events",
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://10.0.0.8/hook",
    "https://192.168.1.2/hook",
    "https://172.16.0.1/hook",
    "https://user:pass@hooks.hotel.com/hook",
    "https://[::1]/hook",
    "https://0.0.0.0/hook"
  ]) assert.throws(() => validateWebhookUrl(url), undefined, url);
});

test("notification redirects are disabled", async () => {
  let request;
  await deliverStaffEscalation({
    ...input,
    fetchImpl: async (_url, options) => { request = options; return { ok: true }; }
  });
  assert.equal(request.redirect, "error");
});

test("integration test event is signed and marked as a test", async () => {
  let request;
  await deliverStaffEscalation({
    ...input, event: "veyra.integration.test", test: true,
    fetchImpl: async (_url, options) => { request = options; return { ok: true }; }
  });
  const payload = JSON.parse(request.body);
  assert.equal(payload.event, "veyra.integration.test");
  assert.equal(payload.test, true);
  assert.equal(payload.conversationId, undefined);
  assert.equal(request.headers["x-veyra-signature"], crypto.createHmac("sha256", input.webhookSecret).update(request.body).digest("hex"));
});
