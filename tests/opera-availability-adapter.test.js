"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createOperaAvailabilityAdapter } = require("../opera-availability-adapter");
const { createPmsAdapterRegistry } = require("../pms-provider-registry");

const NOW = new Date("2027-01-01T00:00:00.000Z");
const request = {
  organizationId: "hotel-synthetic",
  arrivalDate: "2027-02-10",
  departureDate: "2027-02-13",
  roomTypeCode: "VILLA-SYNTHETIC",
  adults: 2,
  children: 1
};

function makeAdapter({ mapped = {}, raw = { synthetic: true }, ...overrides } = {}) {
  const calls = [];
  const client = {
    providerId: "oracle_opera",
    readOnly: true,
    async getHotelAvailability(args) {
      calls.push(args);
      return raw;
    }
  };
  const adapter = createOperaAvailabilityAdapter({
    client,
    tenantId: "hotel-synthetic",
    now: () => NOW,
    mapAvailabilityResponse: async (response, context) => ({
      organizationId: context.tenantId,
      arrivalDate: context.arrivalDate,
      departureDate: context.departureDate,
      roomTypeCode: context.roomTypeCode,
      roomsAvailable: 2,
      observedAt: "2027-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:01:00.000Z",
      ...mapped
    }),
    ...overrides
  });
  return { adapter, calls };
}

test("normalizes approved OPERA mapping into Veyra availability contract", async () => {
  const { adapter, calls } = makeAdapter();
  const result = await adapter.availability(request);
  assert.deepEqual(result, {
    organizationId: "hotel-synthetic",
    arrivalDate: request.arrivalDate,
    departureDate: request.departureDate,
    roomTypeCode: request.roomTypeCode,
    roomsAvailable: 2,
    observedAt: "2027-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:01:00.000Z",
    source: "oracle_opera_ohip"
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].roomType, request.roomTypeCode);
  assert.equal(calls[0].roomStayStartDate, request.arrivalDate);
  assert.equal(calls[0].roomStayEndDate, request.departureDate);
  assert.equal(adapter.organizationId, "hotel-synthetic");
  const detachedCheckAvailability = adapter.checkAvailability;
  assert.deepEqual(await detachedCheckAvailability(request), result);

  const registry = createPmsAdapterRegistry();
  registry.register({
    providerId: "oracle_opera",
    tenantId: "hotel-synthetic",
    adapter,
    approved: true
  });
  assert.equal(registry.get({
    providerId: "oracle_opera",
    tenantId: "hotel-synthetic",
    requiredCapabilities: ["availability"]
  }), adapter);
});

test("fails closed for tenant mismatch, altered stay, or missing mapper", async () => {
  const { adapter } = makeAdapter();
  await assert.rejects(adapter.availability({ ...request, organizationId: "other-tenant" }), /Tenant identity/);
  const altered = makeAdapter({ mapped: { departureDate: "2027-02-14" } });
  await assert.rejects(altered.adapter.availability(request), /could not be verified/);
  assert.throws(() => createOperaAvailabilityAdapter({
    client: { providerId: "oracle_opera", readOnly: true, getHotelAvailability() {} },
    tenantId: "hotel-synthetic"
  }), /mapper is required/);
});

test("fails closed for invalid inventory counts and stale timestamps", async () => {
  const negative = makeAdapter({ mapped: { roomsAvailable: -1 } });
  await assert.rejects(negative.adapter.availability(request), /could not be verified/);
  const stale = makeAdapter({ mapped: { validUntil: "2026-12-31T23:59:59.000Z" } });
  await assert.rejects(stale.adapter.availability(request), /freshness/);
  const tooLong = makeAdapter({ mapped: { validUntil: "2027-01-01T00:06:00.000Z" } });
  await assert.rejects(tooLong.adapter.availability(request), /freshness/);
});

test("requires valid stay dates, occupancy, and room type", async () => {
  const { adapter } = makeAdapter();
  await assert.rejects(adapter.availability({ ...request, arrivalDate: "2027-02-30" }), /real calendar date/);
  await assert.rejects(adapter.availability({ ...request, adults: 0 }), /adults/);
  await assert.rejects(adapter.availability({ ...request, roomTypeCode: " " }), /roomTypeCode/);
});
