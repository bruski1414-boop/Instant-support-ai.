"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPaymentOrchestrator } = require("../payment-orchestrator");

function makeIntent(overrides = {}) {
  return {
    id: "intent-123",
    status: "awaiting_payment",
    depositAmountMinor: 50000,
    currency: "EUR",
    idempotencyKey: "booking_request_123",
    expiresAt: new Date(Date.now() + 300000),
    paymentProvider: null,
    paymentProviderReference: null,
    ...overrides,
  };
}

test("checkout is durable and repeated calls reuse the stored session", async () => {
  let stored = null;
  let providerCalls = 0;
  const repository = {
    async getBookingIntent() { return makeIntent(stored || {}); },
    async saveCheckout(value) { stored = { paymentProvider: value.provider, paymentProviderReference: value.providerReference, checkoutUrl: value.checkoutUrl, checkoutExpiresAt: value.checkoutExpiresAt }; },
    async applyVerifiedPaymentEvent() { return { status: "recorded" }; },
  };
  const adapter = {
    async createCheckoutSession(request) {
      providerCalls++;
      return {
        checkoutUrl: "https://payments.example/session/1",
        providerReference: "session-1",
        amountMinor: request.amountMinor,
        currency: request.currency,
        expiresAt: new Date(Date.now() + 120000),
      };
    },
    async verifyWebhook() { throw new Error("unused"); },
  };
  const service = createPaymentOrchestrator({ repository, adapter, providerName: "test-provider" });
  const first = await service.startCheckout({ organizationId: "hotel-1", bookingIntentId: "intent-123" });
  const second = await service.startCheckout({ organizationId: "hotel-1", bookingIntentId: "intent-123" });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(providerCalls, 1);
});

test("checkout fails closed when no provider exists", async () => {
  const repository = {
    async getBookingIntent() { return makeIntent(); },
    async saveCheckout() {},
    async applyVerifiedPaymentEvent() {},
  };
  const service = createPaymentOrchestrator({ repository });
  await assert.rejects(service.startCheckout({ organizationId: "hotel-1", bookingIntentId: "intent-123" }), e => e.code === "PAYMENT_PROVIDER_NOT_CONFIGURED");
});

test("webhook delegates only signature-verified normalized events to durable reconciliation", async () => {
  let applied;
  const repository = {
    async getBookingIntent() { return makeIntent(); },
    async saveCheckout() {},
    async applyVerifiedPaymentEvent(value) { applied = value; return { status: "recorded" }; },
  };
  const adapter = {
    async createCheckoutSession() {},
    async verifyWebhook({ rawBody }) {
      assert.equal(rawBody.toString(), "signed-provider-payload");
      return {
        signatureVerified: true, eventId: "event-1", eventType: "payment.succeeded",
        paymentStatus: "succeeded", providerReference: "payment-1",
        bookingIntentId: "intent-123", amountMinor: 50000, currency: "EUR",
      };
    },
  };
  const service = createPaymentOrchestrator({ repository, adapter, providerName: "test-provider" });
  const result = await service.handleWebhook({ rawBody: Buffer.from("signed-provider-payload"), headers: { signature: "signed" } });
  assert.equal(result.status, "recorded");
  assert.equal(applied.provider, "test-provider");
  assert.equal(applied.event.eventId, "event-1");
});

test("webhook refuses unknown repository outcomes", async () => {
  const repository = {
    async getBookingIntent() {},
    async saveCheckout() {},
    async applyVerifiedPaymentEvent() { return { status: "unsafe" }; },
  };
  const adapter = {
    async verifyWebhook() {
      return {
        signatureVerified: true, eventId: "event-1", eventType: "payment.succeeded",
        paymentStatus: "succeeded", providerReference: "payment-1",
        bookingIntentId: "intent-123", amountMinor: 50000, currency: "EUR",
      };
    },
  };
  const service = createPaymentOrchestrator({ repository, adapter, providerName: "test-provider" });
  await assert.rejects(service.handleWebhook({ rawBody: Buffer.from("payload"), headers: {} }), e => e.code === "PAYMENT_EVENT_NOT_APPLIED");
});
