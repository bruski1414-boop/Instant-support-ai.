"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BookingWorkflowError,
  normalizeGuestDetails,
  calculateDeposit,
  createBookingIntent,
  recordVerifiedDeposit,
  recordConfirmedReservation,
} = require("../booking-workflow");

const quote = {
  availabilityVerified: true,
  expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  checkIn: "2027-01-10",
  checkOut: "2027-01-13",
  roomTypeId: "deluxe",
  roomTypeName: "Deluxe Room",
  guestCount: 2,
  totalAmountMinor: 90000,
  currency: "EUR",
};

test("guest details are normalized and phone numbers must be international", () => {
  assert.deepEqual(normalizeGuestDetails({ name: " Alex   Smith ", phone: "+44 7000 000000" }), {
    name: "Alex Smith", phone: "+447000000000", email: null,
  });
  assert.throws(() => normalizeGuestDetails({ name: "A", phone: "07000000000" }), BookingWorkflowError);
});

test("50 percent deposit uses integer minor units without floating-point currency values", () => {
  assert.deepEqual(calculateDeposit(90001, "EUR"), {
    totalAmountMinor: 90001, depositAmountMinor: 45001, balanceAmountMinor: 45000,
    currency: "EUR", depositPercentage: 50,
  });
  assert.throws(() => calculateDeposit(0, "EUR"), BookingWorkflowError);
});

test("booking intent requires guest confirmation and a fresh verified quote", () => {
  assert.throws(() => createBookingIntent({
    guestConfirmed: false, idempotencyKey: "booking_request_123", quote, guest: { name: "Alex Smith", phone: "+447000000000" },
  }), error => error.code === "GUEST_CONFIRMATION_REQUIRED");
  const intent = createBookingIntent({
    guestConfirmed: true, idempotencyKey: "booking_request_123", quote,
    guest: { name: "Alex Smith", phone: "+447000000000" },
  });
  assert.equal(intent.status, "awaiting_payment");
  assert.equal(intent.depositAmountMinor, 45000);
  assert.equal(intent.reservationId, null);
  assert.throws(() => createBookingIntent({
    guestConfirmed: true, idempotencyKey: "booking_request_123", quote: { ...quote, availabilityVerified: false },
    guest: { name: "Alex Smith", phone: "+447000000000" },
  }), error => error.code === "QUOTE_NOT_VERIFIED");
});

test("only an exact, signature-verified successful deposit advances the booking", () => {
  const intent = createBookingIntent({
    guestConfirmed: true, idempotencyKey: "booking_request_456", quote,
    guest: { name: "Alex Smith", phone: "+447000000000" },
  });
  assert.throws(() => recordVerifiedDeposit(intent, {
    signatureVerified: false, paymentStatus: "succeeded", amountMinor: 45000, currency: "EUR", providerReference: "pay_1",
  }), error => error.code === "PAYMENT_NOT_VERIFIED");
  assert.throws(() => recordVerifiedDeposit(intent, {
    signatureVerified: true, paymentStatus: "succeeded", amountMinor: 44999, currency: "EUR", providerReference: "pay_1",
  }), error => error.code === "PAYMENT_MISMATCH");
  const paid = recordVerifiedDeposit(intent, {
    signatureVerified: true, paymentStatus: "succeeded", amountMinor: 45000, currency: "EUR", providerReference: "pay_1",
  });
  assert.equal(paid.status, "deposit_paid");
  assert.equal(paid.paymentProviderReference, "pay_1");
});

test("reservation cannot be marked confirmed until hotel provider confirms it", () => {
  const intent = createBookingIntent({
    guestConfirmed: true, idempotencyKey: "booking_request_789", quote,
    guest: { name: "Alex Smith", phone: "+447000000000" },
  });
  assert.throws(() => recordConfirmedReservation(intent, {
    providerConfirmed: true, reservationId: "res_123",
  }), error => error.code === "DEPOSIT_REQUIRED");
  const paid = recordVerifiedDeposit(intent, {
    signatureVerified: true, paymentStatus: "succeeded", amountMinor: 45000, currency: "EUR", providerReference: "pay_2",
  });
  assert.throws(() => recordConfirmedReservation(paid, {
    providerConfirmed: false, reservationId: "res_123",
  }), error => error.code === "RESERVATION_NOT_CONFIRMED");
  const confirmed = recordConfirmedReservation(paid, {
    providerConfirmed: true, reservationId: "res_123",
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.reservationId, "res_123");
});
