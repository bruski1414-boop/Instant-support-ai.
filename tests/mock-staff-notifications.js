"use strict";

// Test-only adapter: keep integration tests local while exercising the server's
// tenant-specific notification selection, payload construction and retry flow.
// The real URL/DNS/TLS/HMAC transport is covered by staff-notifications.test.js.
const crypto = require("node:crypto");
const http = require("node:http");
const modulePath = require.resolve("../staff-notifications");
const original = require(modulePath);

async function deliverStaffEscalation(options = {}) {
  if (!options.webhookUrl || !options.webhookSecret) {
    return { configured: false, delivered: false, status: "not_configured" };
  }
  let capture;
  try {
    capture = new URL(process.env.VEYRA_TEST_WEBHOOK_CAPTURE_URL || "");
  } catch {
    return { configured: true, delivered: false, status: "failed" };
  }
  if (capture.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(capture.hostname)) {
    return { configured: true, delivered: false, status: "failed" };
  }

  const test = Boolean(options.test);
  const organization = options.organization || {};
  const payload = {
    event: options.event || "veyra.escalation.created",
    test,
    organizationId: organization.id,
    organizationSlug: organization.slug,
    organization: organization.name,
    ...(options.conversationId && !test ? { conversationId: options.conversationId } : {}),
    ...(options.reason && !test ? { reason: options.reason } : {}),
    idempotencyKey: options.idempotencyKey || null,
    createdAt: new Date().toISOString()
  };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", options.webhookSecret).update(body).digest("hex");

  return new Promise(resolve => {
    const request = http.request({
      hostname: capture.hostname,
      port: capture.port || 80,
      path: capture.pathname + capture.search,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-veyra-signature": signature,
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {})
      }
    }, response => {
      response.resume();
      const delivered = response.statusCode >= 200 && response.statusCode < 300;
      resolve({ configured: true, delivered, status: delivered ? "delivered" : "failed" });
    });
    request.setTimeout(options.timeoutMs || 5000, () => request.destroy(new Error("Test webhook capture timed out.")));
    request.on("error", () => resolve({ configured: true, delivered: false, status: "failed" }));
    request.end(body);
  });
}

require.cache[modulePath].exports = {
  ...original,
  deliverStaffEscalation
};
