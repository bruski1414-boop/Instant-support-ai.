"use strict";

// Deliberately empty until a provider's current official signature format,
// event mapping, checkout flow and integration tests have been implemented.
// Never add a provider name here without a real verifier function.
const PAYMENT_PROVIDER_ADAPTERS = Object.freeze({});

function listPaymentProviderCapabilities(adapters = PAYMENT_PROVIDER_ADAPTERS) {
  return Object.entries(adapters)
    .filter(([name, verify]) => /^[a-z][a-z0-9_-]{1,39}$/.test(name) && typeof verify === "function")
    .map(([provider]) => ({ provider, webhookVerification: true }));
}

function hasPaymentProviderAdapter(provider, adapters = PAYMENT_PROVIDER_ADAPTERS) {
  return typeof provider === "string" &&
    Object.prototype.hasOwnProperty.call(adapters, provider) &&
    typeof adapters[provider] === "function";
}

module.exports = {
  PAYMENT_PROVIDER_ADAPTERS,
  listPaymentProviderCapabilities,
  hasPaymentProviderAdapter,
};
