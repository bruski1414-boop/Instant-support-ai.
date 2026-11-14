"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { deliverStaffEscalation, shouldRetryStaffNotification } = require("../staff-notifications");

const input = {
  organization: { id: "org-1", slug: "aster-house", name: "Aster House" },
  conversationId: "conversation-1",
  reason: "Guest requested staff assistance.",
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
  const payload = JSON.parse(request.body);
  assert.equal(payload.event, "veyra.escalation.created");
  assert.equal(payload.conversationId, input.conversationId);
  assert.equal(payload.reason, input.reason);
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
