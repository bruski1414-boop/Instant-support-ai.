"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  listProviders,
  getProvider,
  normalizeProviderId,
  createPmsAdapterRegistry
} = require("../pms-provider-registry");

test("lists supported PMS families without claiming adapters are live", () => {
  const providers = listProviders();
  assert.deepEqual(providers.map(item => item.id), ["mews", "cloudbeds", "apaleo", "oracle_opera"]);
  assert.ok(providers.every(item => item.approvalRequired === true));
  assert.ok(providers.every(item => item.adapterStatus !== "live"));
});

test("normalizes provider names and aliases", () => {
  assert.equal(normalizeProviderId("Mews"), "mews");
  assert.equal(normalizeProviderId("Cloudbeds PMS"), "cloudbeds");
  assert.equal(normalizeProviderId("OHIP"), "oracle_opera");
  assert.equal(normalizeProviderId("Oracle OPERA Cloud"), "oracle_opera");
  assert.equal(normalizeProviderId("unknown system"), null);
  assert.equal(getProvider("Apaleo").id, "apaleo");
});

test("requires explicit hotel approval before registering an adapter", () => {
  const registry = createPmsAdapterRegistry();
  const adapter = {
    providerId: "mews",
    tenantId: "hotel-123",
    capabilities: ["availability"],
    availability: async () => ({ roomsAvailable: 1 })
  };
  assert.throws(() => registry.register({ providerId: "mews", tenantId: "hotel-123", adapter }), /approval/);
});

test("isolates adapters by tenant and enforces declared capabilities", () => {
  const registry = createPmsAdapterRegistry();
  const adapter = {
    providerId: "mews",
    tenantId: "hotel-123",
    capabilities: ["availability", "reservations"],
    availability: async () => ({ roomsAvailable: 1 }),
    reservations: async () => ({ status: "pending" })
  };
  registry.register({ providerId: "mews", tenantId: "hotel-123", adapter, approved: true });
  assert.equal(registry.get({ providerId: "mews", tenantId: "hotel-999" }), null);
  assert.equal(registry.get({ providerId: "mews", tenantId: "hotel-123", requiredCapabilities: ["rates"] }), null);
  assert.equal(registry.get({ providerId: "mews", tenantId: "hotel-123", requiredCapabilities: ["availability"] }), adapter);
  assert.deepEqual(registry.status({ providerId: "mews", tenantId: "hotel-123" }).capabilities, ["availability", "reservations"]);
});

test("rejects undeclared or missing adapter methods", () => {
  const registry = createPmsAdapterRegistry();
  assert.throws(() => registry.register({
    providerId: "apaleo",
    tenantId: "hotel-123",
    approved: true,
    adapter: { providerId: "apaleo", tenantId: "hotel-123", capabilities: ["reservations"] }
  }), /missing its declared capability/);
});
