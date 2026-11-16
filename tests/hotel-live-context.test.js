"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLiveHotelContext } = require("../hotel-live-context");

const nowUtc = "2026-11-14T10:00:00.000Z";
const fresh = {
  propertyReference: "demo-hotel",
  roomTypeCode: "DELUXE",
  arrivalDate: "2026-12-01",
  departureDate: "2026-12-03",
  roomsAvailable: 2,
  observedAt: "2026-11-14T09:55:00.000Z",
  validUntil: "2026-11-14T10:05:00.000Z",
  sourceEventId: "availability-1"
};

test("includes only currently valid availability and exposes its expiry", () => {
  const result = buildLiveHotelContext({ availabilitySnapshots: [fresh], nowUtc });
  assert.equal(result.availabilityCount, 1);
  assert.match(result.context, /2 room\(s\) reported available/);
  assert.equal(result.availabilityFreshUntil, fresh.validUntil);
});

test("does not present expired availability as current", () => {
  const expired = { ...fresh, validUntil: "2026-11-14T09:59:00.000Z" };
  const result = buildLiveHotelContext({ availabilitySnapshots: [expired], nowUtc });
  assert.equal(result.availabilityCount, 0);
  assert.match(result.context, /No verified, currently valid availability snapshot/);
});

test("does not present future-dated snapshots as current", () => {
  const future = { ...fresh, observedAt: "2026-11-14T10:01:00.000Z", validUntil: "2026-11-14T10:06:00.000Z" };
  const result = buildLiveHotelContext({ availabilitySnapshots: [future], nowUtc });
  assert.equal(result.availabilityCount, 0);
});

test("includes manager-approved service details in a clearly labelled section", () => {
  const result = buildLiveHotelContext({
    serviceInformation: [{ name: "Airport shuttle", category: "transport", status: "available_on_request", details: "Ask reception to arrange a transfer." }],
    nowUtc
  });
  assert.equal(result.serviceCount, 1);
  assert.match(result.context, /manager-approved/);
  assert.match(result.context, /Airport shuttle/);
});

test("rejects invalid lists, oversized input and unsafe timestamps", () => {
  assert.throws(() => buildLiveHotelContext({ availabilitySnapshots: {}, nowUtc }), /must be lists/);
  assert.throws(() => buildLiveHotelContext({ availabilitySnapshots: Array(501).fill(fresh), nowUtc }), /item limits/);
  assert.throws(() => buildLiveHotelContext({ nowUtc: "yesterday" }), /ISO-8601/);
  assert.throws(() => buildLiveHotelContext({ serviceInformation: [{ name: "x".repeat(121) }], nowUtc }), /service.name/);
});
