"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createOperaOhipAvailabilityIntegration } = require("../opera-ohip-availability-integration");
const { createPmsAdapterRegistry } = require("../pms-provider-registry");

function config(overrides = {}) {
  return {
    organizationId: "hotel-synthetic",
    environment: "nonproduction",
    approved: true,
    gatewayUrl: "https://example.oraclecloud.com/gateway",
    appKey: "synthetic-app-key",
    hotelId: "SYNTHETIC-HOTEL",
    getAccessToken: async () => "synthetic-access-token",
    mapAvailabilityResponse: async (_raw, context) => ({
      organizationId: context.tenantId,
      arrivalDate: context.arrivalDate,
      departureDate: context.departureDate,
      roomTypeCode: context.roomTypeCode,
      roomsAvailable: 1,
      observedAt: "2027-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:01:00.000Z"
    }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ synthetic: true })
    }),
    now: () => new Date("2027-01-01T00:00:00.000Z"),
    ...overrides
  };
}

test("composes and registers an approved, non-production, read-only OPERA adapter", async () => {
  const registry = createPmsAdapterRegistry();
  const integration = createOperaOhipAvailabilityIntegration({
    ...config(), registry
  });
  assert.equal(integration.readOnly, true);
  assert.equal(integration.environment, "nonproduction");
  assert.equal(integration.registration.providerId, "oracle_opera");
  assert.equal(registry.get({
    providerId: "oracle_opera",
    tenantId: "hotel-synthetic",
    requiredCapabilities: ["availability"]
  }), integration.adapter);

  const result = await integration.adapter.checkAvailability({
    organizationId: "hotel-synthetic",
    arrivalDate: "2027-02-10",
    departureDate: "2027-02-12",
    roomTypeCode: "VILLA-SYNTHETIC",
    adults: 2,
    children: 0
  });
  assert.equal(result.roomsAvailable, 1);
  assert.equal(result.source, "oracle_opera_ohip");
});

test("refuses production mode, missing approval, and invalid registry", () => {
  assert.throws(() => createOperaOhipAvailabilityIntegration(config({
    environment: "production"
  })), /non-production/);
  assert.throws(() => createOperaOhipAvailabilityIntegration(config({
    approved: false
  })), /Hotel approval/);
  assert.throws(() => createOperaOhipAvailabilityIntegration(config({
    registry: {}
  })), /registry/);
});

test("cannot register an OPERA adapter under a different tenant", () => {
  const registry = createPmsAdapterRegistry();
  assert.throws(() => createOperaOhipAvailabilityIntegration(config({
    organizationId: "hotel-one",
    registry: {
      register: args => registry.register({ ...args, tenantId: "hotel-two" }),
      get: registry.get
    }
  })), /identity must match/);
});
