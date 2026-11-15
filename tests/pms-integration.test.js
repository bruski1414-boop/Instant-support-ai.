"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PmsIntegrationError,
  validateDateRange,
  normalizeAvailability,
  normalizeBookingRequest,
  normalizeBooking,
  createPmsRegistry,
  createSandboxAdapter,
} = require("../pms-integration");

test("date ranges require valid ISO dates and a positive stay", () => {
  assert.deepEqual(validateDateRange({ checkIn: "2027-01-10", checkOut: "2027-01-12" }), {
    checkIn: "2027-01-10", checkOut: "2027-01-12",
  });
  assert.throws(() => validateDateRange({ checkIn: "2027-01-12", checkOut: "2027-01-10" }), PmsIntegrationError);
  assert.throws(() => validateDateRange({ checkIn: "not-a-date", checkOut: "2027-01-10" }), PmsIntegrationError);
  assert.throws(() => validateDateRange({ checkIn: "2027-02-30", checkOut: "2027-03-03" }), PmsIntegrationError);
});

test("availability normalizer accepts only bounded, typed provider fields", () => {
  assert.deepEqual(normalizeAvailability({
    roomTypeId: "deluxe", roomTypeName: "Deluxe Room", currency: "thb", amountMinor: 250000, availableUnits: 3,
  }), { roomTypeId: "deluxe", roomTypeName: "Deluxe Room", currency: "THB", amountMinor: 250000, availableUnits: 3 });
  assert.throws(() => normalizeAvailability({ roomTypeId: "x", roomTypeName: "X", currency: "THB", amountMinor: -1, availableUnits: 2 }), PmsIntegrationError);
  assert.throws(() => normalizeAvailability({ roomTypeId: "x", roomTypeName: "X", currency: "THB", amountMinor: 100, availableUnits: "2" }), PmsIntegrationError);
});

test("booking requests require an idempotency key and bounded guest count", () => {
  assert.deepEqual(normalizeBookingRequest({
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe", guestCount: 2, idempotencyKey: "booking_req_12345",
  }), {
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe", guestCount: 2, idempotencyKey: "booking_req_12345",
  });
  assert.throws(() => normalizeBookingRequest({
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe", guestCount: 2,
  }), PmsIntegrationError);
  assert.throws(() => normalizeBookingRequest({
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe", guestCount: 21, idempotencyKey: "booking_req_12345",
  }), PmsIntegrationError);
});

test("booking responses expose only a validated provider ID and status", () => {
  assert.deepEqual(normalizeBooking({ bookingId: "provider-123", status: "CONFIRMED", guestEmail: "private@example.test" }), {
    bookingId: "provider-123", status: "confirmed",
  });
  assert.throws(() => normalizeBooking({ bookingId: "provider-123", status: "unknown" }), PmsIntegrationError);
});

test("registry advertises sandbox mode without claiming production readiness", async () => {
  const registry = createPmsRegistry([createSandboxAdapter()]);
  assert.deepEqual(registry.list(), [{
    id: "sandbox",
    name: "Veyra PMS adapter sandbox",
    mode: "sandbox",
    capabilities: { availability: true, booking: false, webhooks: false },
  }]);
  assert.deepEqual(await registry.testConnection("sandbox"), {
    provider: "sandbox", providerName: "Veyra PMS adapter sandbox", mode: "sandbox", ok: true, productionReady: false,
  });
  assert.deepEqual(await registry.getAvailability("sandbox", { checkIn: "2027-01-10", checkOut: "2027-01-11" }), []);
  await assert.rejects(() => registry.createBooking("sandbox", {
    checkIn: "2027-01-10", checkOut: "2027-01-11", roomTypeId: "deluxe", guestCount: 2, idempotencyKey: "booking_req_12345",
  }), error => error.code === "CAPABILITY_UNAVAILABLE");
});

test("registry rejects duplicate or incomplete adapters and unknown providers", async () => {
  const adapter = createSandboxAdapter();
  assert.throws(() => createPmsRegistry([adapter, adapter]), error => error.code === "DUPLICATE_ADAPTER");
  assert.throws(() => createPmsRegistry([{ id: "bad", name: "Broken", capabilities: {} }]), error => error.code === "INVALID_ADAPTER");
  const registry = createPmsRegistry();
  await assert.rejects(() => registry.testConnection("unknown"), error => error.code === "PROVIDER_UNAVAILABLE");
});
