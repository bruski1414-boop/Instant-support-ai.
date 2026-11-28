"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createHmacPaymentWebhookVerifier } = require("../payment-provider");
const secret = "test_secret_that_is_long_enough_123";
const now = new Date("2026-11-28T12:00:00.000Z");
function signedRequest(body, timestamp = String(Math.floor(now.getTime() / 1000))) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(timestamp + "."), rawBody])).digest("hex");
  return { rawBody, headers: { "x-payment-timestamp": timestamp, "x-payment-signature": signature }, secret, receivedAt: now };
}
function verifier() {
  return createHmacPaymentWebhookVerifier({ mapEvent: body => body.payment });
}
test("verifies signature and normalizes a successful payment event", () => {
  const event = verifier()(signedRequest({ payment: {
    eventId: " evt_123 ", bookingId: " booking_123 ", paymentId: " pay_123 ",
    amountMinor: 125001, currency: "thb", status: "succeeded",
  } }));
  assert.deepEqual(event, { signatureVerified: true, eventId: "evt_123", bookingId: "booking_123",
    paymentId: "pay_123", amountMinor: 125001, currency: "THB", status: "succeeded" });
});
test("rejects a modified body and stale timestamp", () => {
  const verify = verifier();
  const request = signedRequest({ payment: { eventId:"evt_123", bookingId:"booking_123", paymentId:"pay_123", amountMinor:125001, currency:"THB", status:"succeeded" } });
  request.rawBody = Buffer.from(request.rawBody.toString("utf8") + " ");
  assert.throws(() => verify(request), e => e.code === "INVALID_PAYMENT_WEBHOOK_SIGNATURE");
  assert.throws(() => verify(signedRequest({ payment: {} }, "1760000000")), e => e.code === "STALE_PAYMENT_WEBHOOK");
});
test("rejects malformed, oversized and incomplete events", () => {
  const verify = verifier();
  const malformed = signedRequest({ payment: {} });
  malformed.rawBody = Buffer.from("{");
  const signature = crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(String(Math.floor(now.getTime()/1000)) + "."), malformed.rawBody])).digest("hex");
  malformed.headers["x-payment-signature"] = signature;
  assert.throws(() => verify(malformed), e => e.code === "INVALID_PAYMENT_WEBHOOK_BODY");
  const tooLarge = signedRequest({});
  tooLarge.rawBody = Buffer.alloc(64 * 1024 + 1);
  assert.throws(() => verify(tooLarge), e => e.code === "INVALID_PAYMENT_WEBHOOK_CONTEXT");
  assert.throws(() => verify(signedRequest({ payment: {} })), e => e.code === "INVALID_PAYMENT_WEBHOOK_EVENT");
});
test("requires an explicit provider event mapper", () => {
  assert.throws(() => createHmacPaymentWebhookVerifier(), e => e.code === "INVALID_PAYMENT_WEBHOOK_CONFIG");
});
