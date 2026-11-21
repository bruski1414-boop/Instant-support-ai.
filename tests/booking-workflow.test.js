"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeGuestDetails,
  calculateDeposit,
  buildBookingIntent,
  assertBookingTransition,
} = require("../booking-workflow");

function freshAvailability(overrides = {}) {
  const now = Date.now();
  return {
    propertyReference: "shebara-demo-property",
    roomTypeCode: "deluxe",
    arrivalDate: "2027-01-10",
    departureDate: "2027-01-12",
    roomsAvailable: 2,
    observedAt: new Date(now - 60_000).toISOString(),
    validUntil: new Date(now + 4 * 60_000).toISOString(),
    sourceEventId: "availability_event_123",
    ...overrides,
  };
}

function bookingInput(overrides = {}) {
  return {
    checkIn: "2027-01-10", checkOut: "2027-01-12",
    guest: { name: "Alex Guest", phone: "+66812345678" },
    roomTypeId: "deluxe", guestCount: 2, currency: "THB",
    totalAmountMinor: 100000, idempotencyKey: "booking_req_12345",
    availabilitySnapshot: freshAvailability(),
    ...overrides,
  };
}

test("guest details require an international phone number and reject markup", () => {
  assert.deepEqual(normalizeGuestDetails({
    name: " Alex Guest ", phone: "+66812345678", email: "ALEX@example.com",
  }), { name: "Alex Guest", phone: "+66812345678", email: "alex@example.com" });
  assert.throws(() => normalizeGuestDetails({ name: "<script>x</script>", phone: "+66812345678" }), e => e.code === "INVALID_GUEST_NAME");
  assert.throws(() => normalizeGuestDetails({ name: "Alex Guest", phone: "0812345678" }), e => e.code === "INVALID_GUEST_PHONE");
});

test("50 percent deposit is calculated in integer minor currency units", () => {
  assert.deepEqual(calculateDeposit(10001), {
    totalAmountMinor: 10001, depositPercent: 50, depositAmountMinor: 5001, balanceAmountMinor: 5000,
  });
  assert.throws(() => calculateDeposit(0), e => e.code === "INVALID_DEPOSIT_AMOUNT");
  assert.throws(() => calculateDeposit(10000, 30), e => e.code === "INVALID_DEPOSIT_AMOUNT");
});

test("booking intent requires a fresh snapshot matching the exact room type and stay dates", () => {
  const intent = buildBookingIntent(bookingInput());
  assert.equal(intent.depositAmountMinor, 50000);
  assert.equal(intent.balanceAmountMinor, 50000);
  assert.equal(intent.state, "awaiting_payment");
  assert.deepEqual(intent.availabilityEvidence, {
    propertyReference: "shebara-demo-property",
    roomTypeCode: "deluxe",
    sourceEventId: "availability_event_123",
    observedAt: intent.availabilityEvidence.observedAt,
    validUntil: intent.availabilityEvidence.validUntil,
    roomsAvailable: 2,
  });
});

test("booking intent rejects a boolean claim without provider availability evidence", () => {
  assert.throws(() => buildBookingIntent(bookingInput({
    availabilitySnapshot: undefined,
    availabilityVerified: true,
    availabilityVerifiedAt: new Date().toISOString(),
  })), e => e.code === "AVAILABILITY_NOT_VERIFIED");
});

test("booking intent rejects stale, expired, future, or zero-inventory snapshots", () => {
  const now = Date.now();
  assert.throws(() => buildBookingIntent(bookingInput({
    availabilitySnapshot: freshAvailability({
      observedAt: new Date(now - 6 * 60_000).toISOString(),
      validUntil: new Date(now + 4 * 60_000).toISOString(),
    }),
  })), e => e.code === "AVAILABILITY_NOT_VERIFIED");
  assert.throws(() => buildBookingIntent(bookingInput({
    availabilitySnapshot: freshAvailability({
      observedAt: new Date(now - 60_000).toISOString(),
      validUntil: new Date(now - 1_000).toISOString(),
    }),
  })), e => e.code === "AVAILABILITY_NOT_VERIFIED");
  assert.throws(() => buildBookingIntent(bookingInput({
    availabilitySnapshot: freshAvailability({
      observedAt: new Date(now + 60_000).toISOString(),
      validUntil: new Date(now + 4 * 60_000).toISOString(),
    }),
  })), e => e.code === "AVAILABILITY_NOT_VERIFIED");
  assert.throws(() => buildBookingIntent(bookingInput({
    availabilitySnapshot: freshAvailability({ roomsAvailable: 0 }),
  })), e => e.code === "AVAILABILITY_NOT_VERIFIED");
});

test("booking intent rejects snapshots for a different room type or date range", () => {
  assert.throws(() => buildBookingIntent(bookingInput({
    availabilitySnapshot: freshAvailability({ roomTypeCode: "suite" }),
  })), e => e.code === "AVAILABILITY_NOT_VERIFIED");
  assert.throws(() => buildBookingIntent(bookingInput({
    availabilitySnapshot: freshAvailability({ arrivalDate: "2027-01-11" }),
  })), e => e.code === "AVAILABILITY_NOT_VERIFIED");
  assert.throws(() => buildBookingIntent(bookingInput({
    availabilitySnapshot: freshAvailability({ departureDate: "2027-01-13" }),
  })), e => e.code === "AVAILABILITY_NOT_VERIFIED");
});

test("payment and PMS confirmation require independently verified evidence", () => {
  assert.throws(() => assertBookingTransition("payment_pending", "payment_verified", {}), e => e.code === "PAYMENT_NOT_VERIFIED");
  assert.equal(assertBookingTransition("payment_pending", "payment_verified", { paymentProviderVerified: true }), "payment_verified");
  assert.throws(() => assertBookingTransition("booking_pending", "confirmed", { pmsConfirmed: true }), e => e.code === "PMS_BOOKING_NOT_CONFIRMED");
  assert.equal(assertBookingTransition("booking_pending", "confirmed", {
    pmsConfirmed: true, pmsBookingId: "PMS-123",
  }), "confirmed");
  assert.throws(() => assertBookingTransition("awaiting_payment", "confirmed", {}), e => e.code === "INVALID_BOOKING_TRANSITION");
});
