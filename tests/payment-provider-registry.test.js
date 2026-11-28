"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PAYMENT_PROVIDER_ADAPTERS,
  listPaymentProviderCapabilities,
  hasPaymentProviderAdapter
} = require("../payment-provider-registry");

test("no payment provider is advertised until its real adapter is registered", () => {
  assert.deepEqual(PAYMENT_PROVIDER_ADAPTERS, {});
  assert.deepEqual(listPaymentProviderCapabilities(), []);
  assert.equal(hasPaymentProviderAdapter("stripe"), false);
});

test("only callable adapters with valid provider identifiers are listed", () => {
  const adapters = {
    testpay: () => ({ signatureVerified: true }),
    "Bad Provider": () => true,
    missing: null
  };
  assert.deepEqual(listPaymentProviderCapabilities(adapters), [
    { provider: "testpay", webhookVerification: true }
  ]);
  assert.equal(hasPaymentProviderAdapter("testpay", adapters), true);
  assert.equal(hasPaymentProviderAdapter("missing", adapters), false);
  assert.equal(hasPaymentProviderAdapter("Bad Provider", adapters), false);
});

test("provider capability checks do not accept inherited object properties", () => {
  const adapters = Object.create({ stripe: () => true });
  assert.equal(hasPaymentProviderAdapter("stripe", adapters), false);
});
