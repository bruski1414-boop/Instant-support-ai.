"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeReservationEvent,
  normalizeAvailabilitySnapshot,
  createPmsAdapter
} = require("../pms-integration");

const reservation = {
  eventId: "evt-100",
  eventType: "reservation.created",
  occurredAt: "2026-11-14T10:00:00.000Z",
  reservationId: "res-200",
  status: "confirmed",
  arrivalDate: "2026-12-01",
  departureDate: "2026-12-05",
  roomTypeCode: "DELUXE",
  currency: "EUR",
  totalAmountMinor: 84000,
  guestName: "Must not be retained",
  guestEmail: "guest@example.invalid",
  paymentCard: "never store"
};

const availability = {
  propertyReference: "hotel-1",
  roomTypeCode: "DELUXE",
  arrivalDate: "2026-12-01",
  departureDate: "2026-12-05",
  roomsAvailable: 3,
  observedAt: "2026-11-14T10:00:00.000Z",
  validUntil: "2026-11-14T10:10:00.000Z",
  sourceEventId: "availability-1"
};

test("normalizes a reservation event and drops guest/payment PII", () => {
  const value = normalizeReservationEvent(reservation);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.eventType, "reservation.created");
  assert.equal(value.totalAmountMinor, 84000);
  assert.equal("guestName" in value, false);
  assert.equal("guestEmail" in value, false);
  assert.equal("paymentCard" in value, false);
});

test("rejects unsupported event types and invalid reservation dates", () => {
  assert.throws(() => normalizeReservationEvent({ ...reservation, eventType: "payment.card_authorized" }), /Unsupported/);
  assert.throws(() => normalizeReservationEvent({ ...reservation, departureDate: "2026-12-01" }), /after arrivalDate/);
  assert.throws(() => normalizeReservationEvent({ ...reservation, totalAmountMinor: 12.5 }), /safe integer/);
});

test("requires currency when a reservation total is supplied", () => {
  assert.throws(() => normalizeReservationEvent({ ...reservation, currency: null }), /currency is required/);
});

test("normalizes short-lived availability snapshots", () => {
  const value = normalizeAvailabilitySnapshot(availability);
  assert.equal(value.roomsAvailable, 3);
  assert.equal(value.validUntil, "2026-11-14T10:10:00.000Z");
});

test("rejects stale or excessively long-lived availability snapshots", () => {
  assert.throws(() => normalizeAvailabilitySnapshot({ ...availability, validUntil: "2026-11-14T10:16:00.000Z" }), /15 minutes/);
  assert.throws(() => normalizeAvailabilitySnapshot({ ...availability, validUntil: "2026-11-14T09:59:00.000Z" }), /later than observedAt/);
});

test("requires an adapter to map both canonical event types", () => {
  assert.throws(() => createPmsAdapter({ provider: "example", mapReservationEvent() {} }), /must implement/);
  const adapter = createPmsAdapter({
    provider: "Example PMS",
    mapReservationEvent: payload => payload,
    mapAvailabilitySnapshot: payload => payload
  });
  assert.equal(adapter.provider, "Example PMS");
  assert.equal(adapter.reservationEvent(reservation).reservationId, "res-200");
  assert.equal(adapter.availabilitySnapshot(availability).roomsAvailable, 3);
});
