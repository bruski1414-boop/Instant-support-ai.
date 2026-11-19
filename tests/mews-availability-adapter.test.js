"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsAvailabilityAdapter } = require("../mews-availability-adapter");

const dates = [
  "2026-12-02T00:00:00.000Z",
  "2026-12-03T00:00:00.000Z",
  "2026-12-04T00:00:00.000Z"
];

function adapter(response) {
  const calls = [];
  const value = createMewsAvailabilityAdapter({
    client: {
      providerId: "mews",
      readOnly: true,
      async getAvailability(payload) {
        calls.push(payload);
        return response;
      }
    },
    tenantId: "hotel-demo",
    serviceId: "room-service",
    resourceCategoryId: "ocean-villa",
    timeUnitStartsUtc: dates
  });
  return { value, calls };
}

test("returns the minimum availability across every night of the stay", async () => {
  const a = adapter({
    TimeUnitStartsUtc: dates,
    CategoryAvailabilities: [{ CategoryId: "ocean-villa", Availabilities: [4, 2, 3] }]
  });
  const result = await a.value.checkAvailability({
    arrivalDate: "2026-12-02",
    departureDate: "2026-12-05",
    roomTypeCode: "ocean-villa"
  });
  assert.equal(result.roomsAvailable, 2);
  assert.equal(result.organizationId, "hotel-demo");
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].ServiceId, "room-service");
});

test("fails closed when one night has zero availability", async () => {
  const a = adapter({
    TimeUnitStartsUtc: dates,
    CategoryAvailabilities: [{ CategoryId: "ocean-villa", Availabilities: [4, 0, 3] }]
  });
  const result = await a.value.checkAvailability({
    arrivalDate: "2026-12-02",
    departureDate: "2026-12-05",
    roomTypeCode: "ocean-villa"
  });
  assert.equal(result.roomsAvailable, 0);
});

test("rejects missing category, incomplete dates and mismatched time units", async () => {
  const a = adapter({ TimeUnitStartsUtc: dates, CategoryAvailabilities: [] });
  await assert.rejects(() => a.value.checkAvailability({
    arrivalDate: "2026-12-02", departureDate: "2026-12-05", roomTypeCode: "ocean-villa"
  }), /complete availability/);
  const b = adapter({
    TimeUnitStartsUtc: dates.slice(0, 2),
    CategoryAvailabilities: [{ CategoryId: "ocean-villa", Availabilities: [1, 1] }]
  });
  await assert.rejects(() => b.value.checkAvailability({
    arrivalDate: "2026-12-02", departureDate: "2026-12-05", roomTypeCode: "ocean-villa"
  }), /unexpected time units/);
});

test("rejects room-type and tenant mapping mismatches", async () => {
  const a = adapter({ TimeUnitStartsUtc: dates, CategoryAvailabilities: [] });
  await assert.rejects(() => a.value.checkAvailability({
    arrivalDate: "2026-12-02", departureDate: "2026-12-05", roomTypeCode: "other-category"
  }), /does not match/);
});
