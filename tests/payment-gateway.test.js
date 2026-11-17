"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PaymentGatewayError,
  validateBookingIntent,
  createCheckoutSession,
  verifyPaymentWebhook,
} = require("../payment-gateway");

function intent(overrides = {}) {
  return {
    id: "booking-123",
    status: "awaiting_payment",
    depositAmountMinor: 45000,
    currency: "EUR",
    idempotencyKey: "booking_request_123",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    ...overrides,
  };
}

test("checkout accepts only an unexpired awaiting-payment intent", () => {
  assert.doesNotThrow(() => validateBookingIntent(intent()));
  assert.throws(() => validateBookingIntent(intent({ status: "confirmed" })), e => e.code === "BOOKING_NOT_PAYABLE");
  assert.throws(() => validateBookingIntent(intent({ expiresAt: new Date(Date.now() - 1000) })), e => e.code === "BOOKING_NOT_PAYABLE");
});

test("checkout is provider-neutral and enforces exact amount, currency and HTTPS URL", async () => {
  const booking = intent();
  const adapter = {
    async createCheckoutSession(request) {
      assert.equal(request.amountMinor, 45000);
      assert.equal(request.currency, "EUR");
      return {
        checkoutUrl: "https://payments.example/checkout/abc",
        providerReference: "session_abc",
        amountMinor: 45000,
        currency: "EUR",
        expiresAt: new Date(Date.now() + 2 * 60 * 1000),
      };
    },
  };
  const result = await createCheckoutSession(adapter, booking);
  assert.equal(result.providerReference, "session_abc");
  assert.equal(result.amountMinor, 45000);
  assert.equal(new URL(result.checkoutUrl).protocol, "https:");
});

test("checkout rejects provider amount, currency, URL and expiry mismatches", async () => {
  const badResults = [
    { checkoutUrl: "https://payments.example/x", providerReference: "p1", amountMinor: 44999, currency: "EUR", expiresAt: new Date(Date.now() + 60000) },
    { checkoutUrl: "https://payments.example/x", providerReference: "p1", amountMinor: 45000, currency: "USD", expiresAt: new Date(Date.now() + 60000) },
    { checkoutUrl: "http://payments.example/x", providerReference: "p1", amountMinor: 45000, currency: "EUR", expiresAt: new Date(Date.now() + 60000) },
    { checkoutUrl: "https://payments.example/x", providerReference: "p1", amountMinor: 45000, currency: "EUR", expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
  ];
  for (const result of badResults) {
    await assert.rejects(
      createCheckoutSession({ createCheckoutSession: async () => result }, intent()),
      e => e instanceof PaymentGatewayError && e.code === "INVALID_CHECKOUT_RESPONSE",
    );
  }
});

test("checkout fails closed when no provider is configured or provider errors", async () => {
  await assert.rejects(createCheckoutSession(null, intent()), e => e.code === "PAYMENT_PROVIDER_NOT_CONFIGURED");
  await assert.rejects(createCheckoutSession({ createCheckoutSession: async () => { throw new Error("secret"); } }, intent()), e => e.code === "CHECKOUT_CREATION_FAILED");
});

test("webhook processing requires original bytes and a signature-verified canonical event", async () => {
  const rawBody = Buffer.from('{"event":"payment.succeeded"}');
  const adapter = {
    async verifyWebhook(input) {
      assert.deepEqual(input.rawBody, rawBody);
      return {
        signatureVerified: true,
        eventId: "evt_123",
        eventType: "payment.succeeded",
        paymentStatus: "succeeded",
        providerReference: "pay_123",
        bookingIntentId: "booking-123",
        amountMinor: 45000,
        currency: "EUR",
      };
    },
  };
  const event = await verifyPaymentWebhook(adapter, { rawBody, headers: { "x-signature": "provider-specific" } });
  assert.equal(event.signatureVerified, true);
  assert.equal(event.amountMinor, 45000);
  await assert.rejects(verifyPaymentWebhook(adapter, { rawBody: Buffer.alloc(0), headers: {} }), e => e.code === "INVALID_WEBHOOK_INPUT");
});

test("unverified and mismatched webhook events are rejected", async () => {
  const rawBody = Buffer.from("payload");
  const base = {
    eventId: "evt_123", eventType: "payment.succeeded", paymentStatus: "succeeded",
    providerReference: "pay_123", bookingIntentId: "booking-123", amountMinor: 45000, currency: "EUR",
  };
  for (const event of [
    { ...base, signatureVerified: false },
    { ...base, signatureVerified: true, amountMinor: 44999 },
    { ...base, signatureVerified: true, currency: "USD" },
    { ...base, signatureVerified: true, paymentStatus: "unknown" },
  ]) {
    await assert.rejects(
      verifyPaymentWebhook({ verifyWebhook: async () => event }, { rawBody, headers: {} }),
      e => e.code === "UNTRUSTED_WEBHOOK_EVENT",
    );
  }
  await assert.rejects(
    verifyPaymentWebhook({ verifyWebhook: async () => { throw new Error("bad signature"); } }, { rawBody, headers: {} }),
    e => e.code === "WEBHOOK_VERIFICATION_FAILED",
  );
});
