"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { deliverStaffEscalation, shouldRetryStaffNotification, dispatchStaffNotification } = require("../staff-notifications");

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

function fakeDb({ claimRows = 1, currentStatus = "failed" } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith("UPDATE escalations SET notification_status='sending'")) return { rowCount: claimRows, rows: claimRows ? [{ id: "escalation-123" }] : [] };
      if (sql.startsWith("SELECT notification_status")) return { rowCount: 1, rows: [{ notification_status: currentStatus, notification_attempts: 3 }] };
      if (sql.startsWith("UPDATE escalations SET notification_status=$1")) return { rowCount: 1, rows: [] };
      throw new Error("Unexpected database query");
    }
  };
}

test("dispatcher claims an open escalation before sending and persists delivery", async () => {
  const db = fakeDb();
  let delivered = false;
  const result = await dispatchStaffNotification({
    db, organizationId: "org-1", escalationId: "escalation-123", maxAttempts: 5,
    deliver: async () => { delivered = true; return { configured: true, delivered: true, status: "delivered" }; }
  });
  assert.equal(delivered, true);
  assert.deepEqual(result, { configured: true, delivered: true, status: "delivered", claimed: true });
  assert.match(db.calls[0].sql, /status<>'resolved'/);
  assert.match(db.calls[0].sql, /notification_attempts<\$3/);
  assert.match(db.calls[0].sql, /interval '2 minutes'/);
  assert.deepEqual(db.calls[1].params, ["delivered", true, "escalation-123", "org-1"]);
});

test("dispatcher does not send when another request owns the lease or retry limit is reached", async () => {
  const db = fakeDb({ claimRows: 0, currentStatus: "sending" });
  let called = false;
  const result = await dispatchStaffNotification({
    db, organizationId: "org-1", escalationId: "escalation-123",
    deliver: async () => { called = true; return { configured: true, delivered: true, status: "delivered" }; }
  });
  assert.equal(called, false);
  assert.deepEqual(result, { claimed: false, status: "sending", configured: true, delivered: false });
  assert.equal(db.calls.length, 2);
});

test("dispatcher persists failed delivery and propagates a safe failure if delivery throws", async () => {
  const db = fakeDb();
  const result = await dispatchStaffNotification({
    db, organizationId: "org-1", escalationId: "escalation-123",
    deliver: async () => { throw new Error("private webhook error"); }
  });
  assert.deepEqual(result, { configured: true, delivered: false, status: "failed", claimed: true });
  assert.deepEqual(db.calls[1].params, ["failed", true, "escalation-123", "org-1"]);
});
