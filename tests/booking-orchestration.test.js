"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createReservationAfterVerifiedDeposit } = require("../booking-orchestration");

function fixtures() {
  return {
    booking: {
      state: "payment_verified",
      checkIn: "2027-02-10",
      checkOut: "2027-02-12",
      roomTypeId: "ocean-villa",
      guestCount: 2,
      currency: "THB",
      depositAmountMinor: 125000,
      idempotencyKey: "booking_req_12345",
    },
    paymentEvidence: {
      verified: true,
      status: "succeeded",
      providerPaymentId: "pay_123",
      amountMinor: 125000,
      currency: "THB",
    },
  };
}

test("creates a PMS reservation only after exact verified deposit evidence", async () => {
  const { booking, paymentEvidence } = fixtures();
  const calls = [];
  const result = await createReservationAfterVerifiedDeposit({
    booking,
    paymentEvidence,
    provider: "hotel-pms",
    context: { organizationId: "hotel-a" },
    pms: {
      async createBooking(provider, request, context) {
        calls.push({ provider, request, context });
        return { bookingId: "res-987", status: "confirmed" };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "hotel-pms");
  assert.equal(calls[0].request.idempotencyKey, booking.idempotencyKey);
  assert.equal(calls[0].context.organizationId, "hotel-a");
  assert.deepEqual(result, {
    state: "confirmed",
    confirmed: true,
    requiresStaffReview: false,
    pmsBookingId: "res-987",
    paymentProviderId: "pay_123",
    guestMessage: "Your reservation is confirmed.",
  });
});

test("does not call the PMS if payment is missing, failed, or mismatched", async () => {
  const { booking, paymentEvidence } = fixtures();
  let calls = 0;
  const pms = { async createBooking() { calls += 1; return { bookingId: "res-1", status: "confirmed" }; } };

  await assert.rejects(() => createReservationAfterVerifiedDeposit({
    booking: { ...booking, state: "awaiting_payment" }, paymentEvidence, pms, provider: "hotel-pms",
  }), error => error.code === "PAYMENT_NOT_VERIFIED");
  await assert.rejects(() => createReservationAfterVerifiedDeposit({
    booking, paymentEvidence: { ...paymentEvidence, amountMinor: 1 }, pms, provider: "hotel-pms",
  }), error => error.code === "DEPOSIT_EVIDENCE_MISMATCH");
  await assert.rejects(() => createReservationAfterVerifiedDeposit({
    booking, paymentEvidence: { ...paymentEvidence, status: "processing" }, pms, provider: "hotel-pms",
  }), error => error.code === "DEPOSIT_EVIDENCE_MISMATCH");
  assert.equal(calls, 0);
});

test("a PMS pending response never becomes a confirmed guest booking", async () => {
  const { booking, paymentEvidence } = fixtures();
  const result = await createReservationAfterVerifiedDeposit({
    booking, paymentEvidence, provider: "hotel-pms",
    pms: { async createBooking() { return { bookingId: "res-pending", status: "pending" }; } },
  });
  assert.equal(result.state, "booking_pending");
  assert.equal(result.confirmed, false);
  assert.equal(result.requiresStaffReview, false);
  assert.equal(result.pmsBookingId, "res-pending");
});

test("a PMS timeout is treated as unknown and requires staff review", async () => {
  const { booking, paymentEvidence } = fixtures();
  let calls = 0;
  const result = await createReservationAfterVerifiedDeposit({
    booking, paymentEvidence, provider: "hotel-pms",
    pms: { async createBooking() { calls += 1; throw new Error("network timeout"); } },
  });
  assert.equal(calls, 1);
  assert.equal(result.state, "booking_pending");
  assert.equal(result.confirmed, false);
  assert.equal(result.requiresStaffReview, true);
  assert.equal(result.reason, "pms_result_unknown");
});

test("missing PMS booking reference cannot confirm a reservation", async () => {
  const { booking, paymentEvidence } = fixtures();
  const result = await createReservationAfterVerifiedDeposit({
    booking, paymentEvidence, provider: "hotel-pms",
    pms: { async createBooking() { return { status: "confirmed" }; } },
  });
  assert.equal(result.state, "booking_pending");
  assert.equal(result.confirmed, false);
  assert.equal(result.requiresStaffReview, true);
});

test("missing PMS configuration fails closed", async () => {
  const { booking, paymentEvidence } = fixtures();
  await assert.rejects(() => createReservationAfterVerifiedDeposit({
    booking, paymentEvidence, provider: "hotel-pms",
  }), error => error.code === "PMS_NOT_CONFIGURED" && error.status === 503);
});
