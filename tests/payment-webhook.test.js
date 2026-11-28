"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { processPaymentWebhook, createPaymentWebhookRequestHandler } = require("../payment-webhook");

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

test("endpoint handler derives tenant and provider only from the opaque token mapping", async () => {
  let lookupArgs;
  let recordArgs;
  const handler = createPaymentWebhookRequestHandler({
    db: {},
    vault: { configured: true },
    providerVerifiers: { testpay: () => ({
      signatureVerified: true, eventId: "evt_1", bookingId: "booking_1",
      paymentId: "pay_1", amountMinor: 5000, currency: "THB", status: "succeeded",
    }) },
    async recordDeposit(...args) { recordArgs = args; return { accepted: true, duplicate: false, state: "payment_verified" }; },
  });
  const credentialModule = require("../payment-credential-vault");
  const original = credentialModule.loadPaymentConnectionByEndpointToken;
  // The request handler uses a module dependency; exercise the resolver through
  // a real fake database row and a vault decrypt stub.
  const crypto = require("node:crypto");
  const token = "A".repeat(43);
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const db = { async query(sql, params) {
    lookupArgs = params;
    assert.match(sql, /webhook_endpoint_token_hash/);
    assert.equal(params[0], tokenHash);
    return { rowCount: 1, rows: [{ organization_id: "tenant-from-token", provider: "testpay", encrypted_webhook_secret: "ciphertext" }] };
  }};
  const routed = createPaymentWebhookRequestHandler({
    db, vault: { configured: true, decrypt: () => "secret-long-enough-for-test" },
    providerVerifiers: { testpay: () => ({
      signatureVerified: true, eventId: "evt_1", bookingId: "booking_1",
      paymentId: "pay_1", amountMinor: 5000, currency: "THB", status: "succeeded",
    }) },
    async recordDeposit(...args) { recordArgs = args; return { accepted: true, duplicate: false, state: "payment_verified" }; },
  });
  const result = await routed({ endpointToken: token, headers: {}, rawBody: Buffer.from("{}") });
  assert.equal(result.status, 200);
  assert.equal(recordArgs[1], "tenant-from-token");
  assert.equal(recordArgs[2], "testpay");
  assert.equal(lookupArgs[0], tokenHash);
  void original;
});

test("endpoint handler fails closed for unknown tokens and unregistered providers", async () => {
  const missing = createPaymentWebhookRequestHandler({
    db: { async query() { return { rowCount: 0, rows: [] }; } },
    vault: { configured: true }, providerVerifiers: {},
  });
  assert.equal((await missing({ endpointToken: "A".repeat(43), headers: {}, rawBody: Buffer.from("{}") })).status, 404);
  const token = "B".repeat(43);
  const crypto = require("node:crypto");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const unregistered = createPaymentWebhookRequestHandler({
    db: { async query(sql, params) {
      assert.equal(params[0], tokenHash);
      return { rowCount: 1, rows: [{ organization_id: "tenant-a", provider: "futurepay", encrypted_webhook_secret: "ciphertext" }] };
    }},
    vault: { configured: true, decrypt: () => "secret-long-enough-for-test" },
    providerVerifiers: {},
  });
  assert.equal((await unregistered({ endpointToken: token, headers: {}, rawBody: Buffer.from("{}") })).status, 503);
});
