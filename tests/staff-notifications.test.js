"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { deliverStaffEscalation } = require("../staff-notifications");

const input = {
  organization: { id: "org-1", slug: "aster-house", name: "Aster House" },
  conversationId: "conversation-1",
  reason: "Guest requested staff assistance.",
  webhookConfig: { url: "https://hotel.example.test/veyra", secret: "test-only-secret-long-enough-123456" }
};

test("staff escalation is explicitly not configured when hotel webhook credentials are absent", async () => {
  const result = await deliverStaffEscalation({ ...input, webhookConfig: null });
  assert.deepEqual(result, { configured: false, delivered: false, status: "not_configured" });
});

test("staff escalation sends a signed tenant-specific event and reports successful delivery", async () => {
  let request;
  const result = await deliverStaffEscalation({
    ...input,
    postImpl: async (url, secret, event, options) => {
      request = { url, secret, event, options };
      return { ok: true, statusCode: 200 };
    }
  });
  assert.equal(result.status, "delivered");
  assert.equal(result.delivered, true);
  assert.equal(request.url, input.webhookConfig.url);
  assert.equal(request.secret, input.webhookConfig.secret);
  assert.equal(request.options.timeoutMs, 5000);
  assert.equal(request.event.organizationId, input.organization.id);
  assert.equal(request.event.organizationSlug, input.organization.slug);
  assert.equal(request.event.conversationId, input.conversationId);
  assert.equal(request.event.reason, input.reason);
  const body = JSON.stringify(request.event);
  assert.equal(crypto.createHmac("sha256", request.secret).update(body).digest("hex").length, 64);
});

test("non-success webhook responses are reported as failed delivery", async () => {
  const result = await deliverStaffEscalation({ ...input, postImpl: async () => ({ ok: false, statusCode: 503 }) });
  assert.deepEqual(result, { configured: true, delivered: false, status: "failed" });
});

test("network errors are reported as failed delivery without leaking endpoint details", async () => {
  const result = await deliverStaffEscalation({ ...input, postImpl: async () => { throw new Error("private endpoint details"); } });
  assert.deepEqual(result, { configured: true, delivered: false, status: "failed" });
});

const { deliverStaffBookingNotification } = require("../staff-notifications");

test("new booking notification sends a signed event without guest contact or payment details", async () => {
  let request;
  const result = await deliverStaffBookingNotification({
    organization: { id: "org-1", slug: "aster-house", name: "Aster House" },
    bookingId: "booking-123",
    state: "awaiting_payment",
    webhookConfig: input.webhookConfig,
    postImpl: async (url, secret, event, options) => {
      request = { url, secret, event, options };
      return { ok: true, statusCode: 200 };
    }
  });
  assert.deepEqual(result, { configured: true, delivered: true, status: "delivered" });
  assert.equal(request.event.event, "veyra.booking.requested");
  assert.equal(request.event.bookingId, "booking-123");
  assert.equal(request.event.organizationId, "org-1");
  assert.equal(request.event.state, "awaiting_payment");
  assert.equal(request.event.dashboardPath, "/dashboard.html");
  assert.equal(request.event.guestPhone, undefined);
  assert.equal(request.event.guestEmail, undefined);
  assert.equal(request.event.depositAmountMinor, undefined);
  assert.equal(request.options.timeoutMs, 5000);
});

test("booking notifications reject invalid booking states without sending", async () => {
  let sent = false;
  const result = await deliverStaffBookingNotification({
    organization: { id: "org-1", slug: "aster-house" },
    bookingId: "booking-123",
    state: "confirmed",
    webhookConfig: input.webhookConfig,
    postImpl: async () => { sent = true; return { ok: true }; }
  });
  assert.deepEqual(result, { configured: false, delivered: false, status: "invalid_event" });
  assert.equal(sent, false);
});

test("booking notification delivery failures are contained", async () => {
  const result = await deliverStaffBookingNotification({
    organization: { id: "org-1", slug: "aster-house" },
    bookingId: "booking-123",
    state: "awaiting_payment",
    webhookConfig: input.webhookConfig,
    postImpl: async () => { throw new Error("private endpoint detail"); }
  });
  assert.deepEqual(result, { configured: true, delivered: false, status: "failed" });
});
