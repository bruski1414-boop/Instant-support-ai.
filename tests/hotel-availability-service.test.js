"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHotelAvailabilityService } = require("../hotel-availability-service");
const { createOperaOhipAvailabilityIntegration } = require("../opera-ohip-availability-integration");
const { createPmsAdapterRegistry } = require("../pms-provider-registry");

const NOW = new Date("2027-01-01T00:00:00.000Z");
const request = {
  arrivalDate: "2027-02-10",
  departureDate: "2027-02-12",
  roomTypeCode: "VILLA-SYNTHETIC",
  adults: 2,
  children: 0
};

function integration(overrides = {}) {
  const registry = createPmsAdapterRegistry();
  const connected = createOperaOhipAvailabilityIntegration({
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
      roomsAvailable: 2,
      observedAt: NOW.toISOString(),
      validUntil: "2027-01-01T00:04:00.000Z",
      ...overrides
    }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ synthetic: true })
    }),
    now: () => NOW,
    registry
  });
  return { registry, connected };
}

test("routes a tenant-scoped availability request through the registered OPERA adapter", async () => {
  const { registry, connected } = integration();
  const service = createHotelAvailabilityService({
    registry,
    providerId: "oracle_opera",
    organizationId: "hotel-synthetic",
    now: () => NOW
  });
  const result = await service.check(request);
  assert.equal(result.status, "available");
  assert.equal(result.roomsAvailable, 2);
  assert.equal(result.providerId, "oracle_opera");
  assert.equal(result.organizationId, "hotel-synthetic");
  assert.equal(connected.readOnly, true);
});

test("does not reveal or query another tenant's adapter", async () => {
  const { registry } = integration();
  const service = createHotelAvailabilityService({
    registry,
    providerId: "oracle_opera",
    organizationId: "different-hotel",
    now: () => NOW
  });
  assert.deepEqual(await service.check(request), {
    status: "staff_handoff",
    reason: "availability_provider_not_configured"
  });
});

test("hands off when inventory is stale or does not match the requested stay", async () => {
  const staleRegistry = {
    get: () => ({
      providerId: "oracle_opera",
      tenantId: "hotel-synthetic",
      async checkAvailability() {
        return {
          organizationId: "hotel-synthetic",
          arrivalDate: request.arrivalDate,
          departureDate: request.departureDate,
          roomTypeCode: request.roomTypeCode,
          roomsAvailable: 2,
          observedAt: "2026-12-31T23:50:00.000Z",
          validUntil: "2027-01-01T00:01:00.000Z"
        };
      }
    })
  };
  const staleService = createHotelAvailabilityService({
    registry: staleRegistry,
    providerId: "oracle_opera",
    organizationId: "hotel-synthetic",
    now: () => NOW
  });
  assert.deepEqual(await staleService.check(request), {
    status: "staff_handoff",
    reason: "stale_inventory"
  });

  const alteredRegistry = {
    get: () => ({
      providerId: "oracle_opera",
      tenantId: "hotel-synthetic",
      async checkAvailability() {
        return {
          organizationId: "hotel-synthetic",
          arrivalDate: request.arrivalDate,
          departureDate: request.departureDate,
          roomTypeCode: "OTHER-ROOM",
          roomsAvailable: 2,
          observedAt: NOW.toISOString(),
          validUntil: "2027-01-01T00:01:00.000Z"
        };
      }
    })
  };
  const alteredService = createHotelAvailabilityService({
    registry: alteredRegistry,
    providerId: "oracle_opera",
    organizationId: "hotel-synthetic",
    now: () => NOW
  });
  assert.deepEqual(await alteredService.check(request), {
    status: "staff_handoff",
    reason: "unverified_inventory"
  });
});

test("rejects malformed stay requests without calling a provider", async () => {
  const { registry } = integration();
  const service = createHotelAvailabilityService({
    registry,
    providerId: "oracle_opera",
    organizationId: "hotel-synthetic",
    now: () => NOW
  });
  assert.deepEqual(await service.check({ ...request, departureDate: request.arrivalDate }), {
    status: "staff_handoff",
    reason: "invalid_availability_request"
  });
});
