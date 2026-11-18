"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeGuestDetails,
  calculateDeposit,
  buildBookingIntent,
  assertBookingTransition,
} = require("../booking-workflow");

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

test("booking intent requires fresh verified availability and safe guest data", () => {
  const now = new Date().toISOString();
  const intent = buildBookingIntent({
    checkIn: "2027-01-10", checkOut: "2027-01-12",
    guest: { name: "Alex Guest", phone: "+66812345678" },
    roomTypeId: "deluxe", guestCount: 2, currency: "THB",
    totalAmountMinor: 100000, idempotencyKey: "booking_req_12345",
    availabilityVerified: true, availabilityVerifiedAt: now,
  });
  assert.equal(intent.depositAmountMinor, 50000);
  assert.equal(intent.balanceAmountMinor, 50000);
  assert.equal(intent.state, "awaiting_payment");
  assert.throws(() => buildBookingIntent({
    checkIn: "2027-01-10", checkOut: "2027-01-12",
    guest: { name: "Alex Guest", phone: "+66812345678" },
    roomTypeId: "deluxe", guestCount: 2, currency: "THB",
    totalAmountMinor: 100000, idempotencyKey: "booking_req_12345",
    availabilityVerified: false,
  }), e => e.code === "AVAILABILITY_NOT_VERIFIED");
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
