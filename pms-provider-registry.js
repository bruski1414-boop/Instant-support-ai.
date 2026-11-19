"use strict";

/**
 * Provider discovery and adapter registry for Veyra.
 * This registry describes vendor/API families; it does not imply that a
 * provider-specific adapter is implemented or that a hotel has authorised it.
 */

const PROVIDERS = Object.freeze({
  mews: Object.freeze({
    id: "mews",
    name: "Mews",
    aliases: ["mews open api", "mews pms"],
    docsUrl: "https://docs.mews.com/",
    apiFamilies: ["connector", "booking-engine", "channel-manager"],
    documentedCapabilities: ["availability", "rates", "reservations", "guest_profiles"],
    authModel: "vendor-issued client token + property-issued access token (API-family dependent)",
    adapterStatus: "contract_only",
    approvalRequired: true
  }),
  cloudbeds: Object.freeze({
    id: "cloudbeds",
    name: "Cloudbeds",
    aliases: ["cloudbeds pms"],
    docsUrl: "https://developers.cloudbeds.com/",
    apiFamilies: ["pms", "guest-profile", "accounting", "data-insights"],
    documentedCapabilities: ["availability", "reservations", "guest_profiles", "webhooks"],
    authModel: "OAuth 2.0; property/group-scoped permissions",
    adapterStatus: "contract_only",
    approvalRequired: true
  }),
  apaleo: Object.freeze({
    id: "apaleo",
    name: "Apaleo",
    aliases: ["apaleo pms"],
    docsUrl: "https://apaleo.dev/",
    apiFamilies: ["booking", "distribution", "profile", "inventory", "webhooks"],
    documentedCapabilities: ["availability", "rates", "reservations", "guest_profiles", "webhooks"],
    authModel: "OAuth 2.0; scopes depend on API and grant",
    adapterStatus: "contract_only",
    approvalRequired: true
  }),
  oracle_opera: Object.freeze({
    id: "oracle_opera",
    name: "Oracle OPERA Cloud (OHIP)",
    aliases: ["opera cloud", "oracle opera", "ohip"],
    docsUrl: "https://docs.oracle.com/en/industries/hospitality/integration-platform/",
    apiFamilies: ["ohip"],
    documentedCapabilities: ["availability", "reservations", "guest_profiles"],
    authModel: "Oracle Hospitality Integration Platform credentials and granted scopes",
    adapterStatus: "not_assessed",
    approvalRequired: true
  })
});

const CAPABILITIES = Object.freeze([
  "availability",
  "rates",
  "reservations",
  "reservation_updates",
  "reservation_cancellations",
  "guest_profiles",
  "webhooks",
  "service_requests"
]);

function normalizeProviderId(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("A PMS provider name is required.");
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.id === normalized.replace(/ /g, "_") ||
        provider.name.toLowerCase() === normalized ||
        provider.aliases.some(alias => alias === normalized)) return provider.id;
  }
  return null;
}

function listProviders() {
  return Object.values(PROVIDERS).map(provider => ({
    ...provider,
    documentedCapabilities: [...provider.documentedCapabilities],
    apiFamilies: [...provider.apiFamilies],
    aliases: [...provider.aliases]
  }));
}

function getProvider(value) {
  const id = normalizeProviderId(value);
  if (!id) return null;
  const provider = PROVIDERS[id];
  return {
    ...provider,
    documentedCapabilities: [...provider.documentedCapabilities],
    apiFamilies: [...provider.apiFamilies],
    aliases: [...provider.aliases]
  };
}

/**
 * Runtime registry. An adapter is usable only after it has been explicitly
 * registered by trusted server code for the tenant's approved connection.
 */
function createPmsAdapterRegistry() {
  const adapters = new Map();

  return Object.freeze({
    register({ providerId, adapter, tenantId, approved = false } = {}) {
      const provider = getProvider(providerId);
      if (!provider) throw new Error("Unsupported PMS provider.");
      if (approved !== true) throw new Error("Hotel approval is required before registering a live PMS adapter.");
      if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("A tenantId is required.");
      if (!adapter || typeof adapter !== "object") throw new Error("A provider adapter is required.");
      if (adapter.providerId !== provider.id || adapter.tenantId !== tenantId) {
        throw new Error("Adapter provider and tenant identity must match the registration.");
      }
      if (!Array.isArray(adapter.capabilities) || adapter.capabilities.length === 0 ||
          adapter.capabilities.some(capability => !CAPABILITIES.includes(capability))) {
        throw new Error("Adapter capabilities must be an explicit list of supported capabilities.");
      }
      for (const capability of adapter.capabilities) {
        if (typeof adapter[capability] !== "function") {
          throw new Error("Adapter is missing its declared capability: " + capability);
        }
      }
      const key = tenantId + ":" + provider.id;
      if (adapters.has(key)) throw new Error("A provider adapter is already registered for this tenant.");
      adapters.set(key, Object.freeze({
        providerId: provider.id,
        tenantId,
        capabilities: Object.freeze([...adapter.capabilities]),
        implementation: adapter
      }));
      return Object.freeze({ providerId: provider.id, tenantId, capabilities: [...adapter.capabilities] });
    },

    get({ providerId, tenantId, requiredCapabilities = [] } = {}) {
      const provider = getProvider(providerId);
      if (!provider || typeof tenantId !== "string") return null;
      const entry = adapters.get(tenantId + ":" + provider.id);
      if (!entry) return null;
      if (!Array.isArray(requiredCapabilities) ||
          requiredCapabilities.some(capability => !entry.capabilities.includes(capability))) return null;
      return entry.implementation;
    },

    status({ providerId, tenantId } = {}) {
      const provider = getProvider(providerId);
      if (!provider) return { connected: false, reason: "unsupported_provider" };
      const entry = adapters.get(tenantId + ":" + provider.id);
      return entry
        ? { connected: true, providerId: provider.id, tenantId, capabilities: [...entry.capabilities] }
        : { connected: false, providerId: provider.id, reason: "adapter_not_configured" };
    }
  });
}

module.exports = { PROVIDERS, CAPABILITIES, listProviders, getProvider, normalizeProviderId, createPmsAdapterRegistry };
