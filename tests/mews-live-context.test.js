"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mapMewsAbsoluteAvailability } = require("../mews-live-context");

const base = {
  availability: {
    timeUnitStartsUtc: ["2026-12-01T23:00:00.000Z", "2026-12-02T23:00:00.000Z"],
    categoryAvailabilities: [{ categoryId: "cat-deluxe", availabilities: [3, 1] }]
  },
  service: { id: "svc-rooms", timeUnitPeriod: "Day" },
  propertyReference: "demo-property",
  timeZone: "Europe/Helsinki",
  observedAt: "2026-11-14T10:00:00.000Z",
  validUntil: "2026-11-14T10:10:00.000Z"
};

test("maps Mews absolute availability into one-night snapshots using property-local dates", () => {
  const snapshots = mapMewsAbsoluteAvailability(base);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].arrivalDate, "2026-12-02");
  assert.equal(snapshots[0].departureDate, "2026-12-03");
  assert.equal(snapshots[0].roomsAvailable, 3);
  assert.equal(snapshots[1].arrivalDate, "2026-12-03");
  assert.equal(snapshots[1].roomsAvailable, 1);
});

test("does not infer multi-night availability; each result is a single room-night", () => {
  const snapshots = mapMewsAbsoluteAvailability(base);
  assert.ok(snapshots.every((item) => {
    const start = new Date(item.arrivalDate + "T00:00:00Z");
    start.setUTCDate(start.getUTCDate() + 1);
    return item.departureDate === start.toISOString().slice(0, 10);
  }));
});

test("rejects non-daily services, misaligned arrays and invalid counts", () => {
  assert.throws(() => mapMewsAbsoluteAvailability({ ...base, service: { ...base.service, timeUnitPeriod: "Hour" } }), /Only daily/);
  assert.throws(() => mapMewsAbsoluteAvailability({ ...base, availability: { ...base.availability, categoryAvailabilities: [{ categoryId: "x", availabilities: [1] }] } }), /align/);
  assert.throws(() => mapMewsAbsoluteAvailability({ ...base, availability: { ...base.availability, categoryAvailabilities: [{ categoryId: "x", availabilities: [-1, 1] }] } }), /non-negative/);
  assert.throws(() => mapMewsAbsoluteAvailability({ ...base, timeZone: "not-a-time-zone" }), /IANA property time zone/);
});

test("returns no room claims when Mews has no categories", () => {
  const snapshots = mapMewsAbsoluteAvailability({ ...base, availability: { ...base.availability, categoryAvailabilities: [] } });
  assert.deepEqual(snapshots, []);
});

test("fetches Mews data through the client and stamps it with a short freshness window", async () => {
  const calls = [];
  const client = {
    async getServiceAvailabilityAbsolute(args) {
      calls.push(args);
      return base.availability;
    }
  };
  const { getMewsRoomNightSnapshots } = require("../mews-live-context");
  const snapshots = await getMewsRoomNightSnapshots({
    client,
    service: base.service,
    propertyReference: base.propertyReference,
    timeZone: base.timeZone,
    firstTimeUnitStartUtc: "2026-12-01T00:00:00.000Z",
    lastTimeUnitStartUtc: "2026-12-02T00:00:00.000Z",
    nowUtc: base.observedAt
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serviceId, base.service.id);
  assert.equal(snapshots[0].observedAt, base.observedAt);
  assert.equal(snapshots[0].validUntil, "2026-11-14T10:10:00.000Z");
});
