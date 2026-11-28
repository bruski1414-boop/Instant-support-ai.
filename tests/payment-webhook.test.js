"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { processPaymentWebhook } = require("../payment-webhook");

const request = {
  verify: () => ({
    signatureVerified: true, eventId: "evt_123", bookingId: "booking_123",
    paymentId: "pay_123", amountMinor: 125000, currency: "THB", status: "succeeded",
  }),
  db: { connect() {} }, organizationId: "hotel-a", provider: "testpay",
  headers: {}, rawBody: Buffer.from("{}"), secret: "test_secret_that_is_long_enough",
};

test("passes only verified evidence into tenant-scoped durable deposit recording", async () => {
  let args;
  const result = await processPaymentWebhook({
    ...request,
    async recordDeposit(...values) {
      args = values;
      return { accepted: true, duplicate: false, state: "payment_verified" };
    },
  });
  assert.equal(args[1], "hotel-a");
  assert.equal(args[2], "testpay");
  assert.equal(args[3].signatureVerified, true);
  assert.equal(result.state, "payment_verified");
  assert.equal(result.bookingId, "booking_123");
});

test("does not write payment evidence when signature verification fails", async () => {
  let writes = 0;
  await assert.rejects(() => processPaymentWebhook({
    ...request,
    verify() { throw Object.assign(new Error("bad signature"), { code: "INVALID_PAYMENT_WEBHOOK_SIGNATURE" }); },
    async recordDeposit() { writes += 1; },
  }), e => e.code === "INVALID_PAYMENT_WEBHOOK_SIGNATURE");
  assert.equal(writes, 0);
});

test("rejects missing tenant or raw body before verification", async () => {
  let verified = 0;
  await assert.rejects(() => processPaymentWebhook({
    ...request, organizationId: "", verify() { verified += 1; },
  }), e => e.code === "PAYMENT_WEBHOOK_NOT_CONFIGURED");
  assert.equal(verified, 0);
});
