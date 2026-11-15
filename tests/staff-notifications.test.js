"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createServer } = require("node:http");
const { sendStaffIntegrationTest, deliverStaffEscalation, shouldRetryStaffNotification, dispatchStaffNotification, retryPendingStaffNotifications } = require("../staff-notifications");
const { validateRetryConfiguration } = require("../scripts/staff-notification-retry");

const input = {
  organization: { id: "org-1", slug: "aster-house", name: "Aster House" },
  conversationId: "conversation-1",
  reason: "Guest requested staff assistance.",
  idempotencyKey: "escalation-123",
  webhookUrl: "https://hotel.example.test/veyra",
  webhookSecret: "test-only-secret"
};

test("retry worker fails closed when encryption or the host allowlist is missing", () => {
  assert.throws(
    () => validateRetryConfiguration({ encryptionConfigured: false, allowedHostsConfigured: true }),
    /STAFF_WEBHOOK_ENCRYPTION_KEY is required/
  );
  assert.throws(
    () => validateRetryConfiguration({ encryptionConfigured: true, allowedHostsConfigured: false }),
    /STAFF_WEBHOOK_ALLOWED_HOSTS must contain an approved host/
  );
  assert.doesNotThrow(() => validateRetryConfiguration({ encryptionConfigured: true, allowedHostsConfigured: true }));
});

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
  assert.equal(request.redirect, "error", "webhook redirects must be rejected to prevent redirect-based SSRF");
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


function statefulNotificationDb() {
  const state = { status: "failed", attempts: 0, lastAttempt: 0, resolved: false };
  const calls = [];
  return {
    state,
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith("UPDATE escalations SET notification_status='sending'")) {
        const maxAttempts = params[2];
        const leaseExpired = state.status !== "sending" || Date.now() - state.lastAttempt > 120000;
        if (state.resolved || state.status === "delivered" || state.attempts >= maxAttempts || !leaseExpired) {
          return { rowCount: 0, rows: [] };
        }
        state.status = "sending";
        state.attempts += 1;
        state.lastAttempt = Date.now();
        return { rowCount: 1, rows: [{ id: "escalation-123" }] };
      }
      if (sql.startsWith("SELECT notification_status")) {
        return { rowCount: 1, rows: [{ notification_status: state.status, notification_attempts: state.attempts }] };
      }
      if (sql.startsWith("UPDATE escalations SET notification_status=$1")) {
        state.status = params[0];
        if (!params[1]) state.attempts -= 1;
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected database query");
    }
  };
}

test("configured webhook failures consume the automatic retry budget and stop at the cap", async () => {
  const db = statefulNotificationDb();
  let deliveryCalls = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await dispatchStaffNotification({
      db, organizationId: "org-1", escalationId: "escalation-123", maxAttempts: 3,
      deliver: async () => {
        deliveryCalls += 1;
        return { configured: true, delivered: false, status: "failed" };
      }
    });
    assert.equal(result.claimed, true);
    assert.equal(result.status, "failed");
    assert.equal(db.state.attempts, attempt);
  }
  const capped = await dispatchStaffNotification({
    db, organizationId: "org-1", escalationId: "escalation-123", maxAttempts: 3,
    deliver: async () => {
      deliveryCalls += 1;
      return { configured: true, delivered: false, status: "failed" };
    }
  });
  assert.equal(capped.claimed, false);
  assert.equal(capped.status, "failed");
  assert.equal(deliveryCalls, 3);
  assert.equal(db.state.attempts, 3);
});

test("unconfigured webhook attempts do not consume the delivery retry budget", async () => {
  const db = statefulNotificationDb();
  const result = await dispatchStaffNotification({
    db, organizationId: "org-1", escalationId: "escalation-123", maxAttempts: 3,
    deliver: async () => ({ configured: false, delivered: false, status: "not_configured" })
  });
  assert.equal(result.claimed, true);
  assert.equal(result.status, "not_configured");
  assert.equal(db.state.attempts, 0);
});


test("staff webhook timeout is treated as a failed delivery", async () => {
  const result = await deliverStaffEscalation({
    ...input,
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("request aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })
  });
  assert.deepEqual(result, { configured: true, delivered: false, status: "failed" });
});

test("staff integration test sends a signed, idempotent event", async () => {
  let request;
  const result = await sendStaffIntegrationTest({
    organization: { id: "org-1", slug: "aster-house", name: "Aster House" },
    webhookUrl: input.webhookUrl, webhookSecret: input.webhookSecret,
    fetchImpl: async (url, options) => { request = { url, ...options }; return { ok: true, status: 200 }; }
  });
  assert.equal(result.verified, true);
  assert.equal(request.url, input.webhookUrl);
  assert.equal(request.redirect, "error", "integration-test webhook redirects must be rejected");
  const body = JSON.parse(request.body);
  assert.equal(body.event, "veyra.integration.test");
  assert.equal(body.test, true);
  assert.equal(body.organizationId, "org-1");
  assert.match(request.headers["idempotency-key"], /^test-/);
  assert.equal(body.idempotencyKey, request.headers["idempotency-key"]);
  const expected = crypto.createHmac("sha256", input.webhookSecret).update(request.body).digest("hex");
  assert.equal(request.headers["x-veyra-signature"], expected);
});

test("staff integration test times out safely and does not verify the connection", async () => {
  const result = await sendStaffIntegrationTest({
    organization: { id: "org-1", slug: "aster-house", name: "Aster House" },
    webhookUrl: input.webhookUrl, webhookSecret: input.webhookSecret, timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  });
  assert.deepEqual(result, { configured: true, verified: false, status: "failed" });
});

test("staff integration test reports missing configuration without making a request", async () => {
  let called = false;
  const result = await sendStaffIntegrationTest({ organization: input.organization, webhookUrl: "", webhookSecret: "", fetchImpl: async () => { called = true; } });
  assert.deepEqual(result, { configured: false, verified: false });
  assert.equal(called, false);
});

test("real fetch rejects webhook redirects without contacting the redirect target", async () => {
  let redirectTargetHits = 0;
  const target = createServer((_req, res) => {
    redirectTargetHits += 1;
    res.writeHead(200);
    res.end("should never be reached");
  });
  const redirector = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/capture` });
    res.end();
  });
  const listen = server => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const close = server => new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
  await listen(target);
  await listen(redirector);
  try {
    const webhookUrl = `http://127.0.0.1:${redirector.address().port}/webhook`;
    const result = await deliverStaffEscalation({
      ...input,
      webhookUrl,
      fetchImpl: fetch
    });
    assert.deepEqual(result, { configured: true, delivered: false, status: "failed" });
    assert.equal(redirectTargetHits, 0, "redirect target must never receive the signed staff event");
  } finally {
    await Promise.all([close(redirector), close(target)]);
  }
});


test("background retry scans only eligible unresolved failures and dispatches each candidate", async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [
        { escalation_id: "e-1", organization_id: "org-1", conversation_id: "c-1", reason: "Needs staff", organization_name: "Hotel One", organization_slug: "hotel-one" },
        { escalation_id: "e-2", organization_id: "org-2", conversation_id: "c-2", reason: "Needs staff", organization_name: "Hotel Two", organization_slug: "hotel-two" }
      ] };
    }
  };
  const dispatched = [];
  const result = await retryPendingStaffNotifications({
    db,
    batchSize: 20,
    dispatch: async row => { dispatched.push(row.escalation_id); return { claimed: true, delivered: true, status: "delivered" }; }
  });
  assert.equal(result.scanned, 2);
  assert.deepEqual(dispatched, ["e-1", "e-2"]);
  assert.match(calls[0].sql, /e.status<>'resolved'/);
  assert.match(calls[0].sql, /JOIN organization_staff_webhooks w ON w.organization_id=e.organization_id AND w.status='verified'/);
  assert.match(calls[0].sql, /notification_status IN \('failed','not_configured'\)/);
  assert.match(calls[0].sql, /notification_attempts<5/);
  assert.match(calls[0].sql, /interval '5 minutes'/);
  assert.match(calls[0].sql, /interval '2 minutes'/);
  assert.deepEqual(calls[0].params, [20]);
});

test("background retry clamps batch size and requires a dispatcher", async () => {
  let limit;
  const db = { query: async (_sql, params) => { limit = params[0]; return { rows: [] }; } };
  const result = await retryPendingStaffNotifications({ db, batchSize: 1000, dispatch: async () => ({}) });
  assert.equal(limit, 100);
  assert.equal(result.scanned, 0);
  await assert.rejects(() => retryPendingStaffNotifications({ db }), /dispatcher is required/);
});
