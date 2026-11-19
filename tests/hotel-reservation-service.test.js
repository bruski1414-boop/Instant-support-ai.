"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHotelReservationService } = require("../hotel-reservation-service");

const NOW = new Date("2026-11-19T08:00:00.000Z");
const request = {
  guestName: "Alex Morgan",
  guestPhone: "+441234567890",
  consentToShareDetails: true,
  arrivalDate: "2026-12-02",
  departureDate: "2026-12-05",
  adults: 2,
  children: 1,
  roomTypeCode: "ocean-villa",
  idempotencyKey: "request_12345678901234567890"
};

function provider(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      organizationId: "hotel-a",
      supportsIdempotency: true,
      async checkAvailability(args) {
        calls.push(["availability", args]);
        return {
          organizationId: "hotel-a",
          arrivalDate: args.arrivalDate,
          departureDate: args.departureDate,
          roomTypeCode: args.roomTypeCode,
          roomsAvailable: 2,
          observedAt: "2026-11-19T07:59:00.000Z",
          validUntil: "2026-11-19T08:04:00.000Z"
        };
      },
      async createReservation(args) {
        calls.push(["create", args]);
        return { organizationId: "hotel-a", status: "confirmed", bookingReference: "HOTEL-48291" };
      },
      ...overrides
    }
  };
}

function service(p) {
  return createHotelReservationService({
    provider: p.value,
    organizationId: "hotel-a",
    now: () => new Date(NOW)
  });
}

test("checks live room inventory before creating a reservation", async () => {
  const p = provider();
  const result = await service(p).book(request);
  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmed, true);
  assert.equal(result.bookingReference, "HOTEL-48291");
  assert.deepEqual(p.calls.map(call => call[0]), ["availability", "create"]);
  assert.equal(p.calls[1][1].idempotencyKey, request.idempotencyKey);
});

test("does not write when the requested room type is sold out", async () => {
  const p = provider({
    async checkAvailability(args) {
      return {
        organizationId: "hotel-a",
        arrivalDate: args.arrivalDate,
        departureDate: args.departureDate,
        roomTypeCode: args.roomTypeCode,
        roomsAvailable: 0,
        observedAt: "2026-11-19T07:59:00.000Z",
        validUntil: "2026-11-19T08:04:00.000Z"
      };
    }
  });
  const result = await service(p).book(request);
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, "room_not_available_or_inventory_stale");
  assert.equal(p.calls.some(call => call[0] === "create"), false);
});

test("does not treat stale inventory as available", async () => {
  const p = provider({
    async checkAvailability(args) {
      return {
        organizationId: "hotel-a",
        arrivalDate: args.arrivalDate,
        departureDate: args.departureDate,
        roomTypeCode: args.roomTypeCode,
        roomsAvailable: 3,
        observedAt: "2026-11-19T07:50:00.000Z",
        validUntil: "2026-11-19T07:55:00.000Z"
      };
    }
  });
  const result = await service(p).book(request);
  assert.equal(result.confirmed, false);
  assert.equal(p.calls.some(call => call[0] === "create"), false);
});

test("never tells a guest a booking is confirmed without provider confirmation and reference", async () => {
  const p = provider({
    async createReservation() {
      return { organizationId: "hotel-a", status: "pending", bookingReference: null };
    }
  });
  const result = await service(p).book(request);
  assert.equal(result.status, "request_pending");
  assert.equal(result.confirmed, false);
});

test("requires consent and a provider idempotency contract", async () => {
  const p = provider();
  await assert.rejects(() => service(p).book({ ...request, consentToShareDetails: false }), /consent/);
  const noIdempotency = provider({ supportsIdempotency: false });
  assert.throws(() => service(noIdempotency), /idempotency/);
});

test("rejects cross-tenant providers before any provider call", () => {
  const p = provider({ organizationId: "hotel-b" });
  assert.throws(() => service(p), /tenant/);
});
