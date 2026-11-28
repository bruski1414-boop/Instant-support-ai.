"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAndPersistReservation } = require("../booking-service");

function fixtures() {
  return {
    booking: {
      state: "payment_verified", checkIn: "2027-02-10", checkOut: "2027-02-12",
      roomTypeId: "ocean-villa", guestCount: 2, currency: "THB",
      totalAmountMinor: 250000, depositAmountMinor: 125000,
      idempotencyKey: "booking_req_12345",
    },
    paymentEvidence: {
      verified: true, status: "succeeded", providerPaymentId: "pay_123",
      amountMinor: 125000, currency: "THB",
    },
  };
}

test("does not return guest confirmation until PMS outcome persistence succeeds", async () => {
  const { booking, paymentEvidence } = fixtures();
  let persisted;
  const result = await createAndPersistReservation({
    booking, bookingId: "booking-1", organizationId: "hotel-a",
    paymentEvidence, provider: "mews",
    pms: { async createBooking() { return { bookingId: "mews-987", status: "confirmed" }; } },
    async persistOutcome(org, id, provider, outcome) {
      persisted = { org, id, provider, outcome };
      return { state: outcome.state, duplicate: false };
    },
  });
  assert.equal(persisted.org, "hotel-a");
  assert.equal(persisted.id, "booking-1");
  assert.equal(persisted.provider, "mews");
  assert.equal(persisted.outcome.state, "confirmed");
  assert.equal(result.confirmed, true);
});

test("a database failure after PMS confirmation keeps guest status pending for staff review", async () => {
  const { booking, paymentEvidence } = fixtures();
  const result = await createAndPersistReservation({
    booking, bookingId: "booking-1", organizationId: "hotel-a",
    paymentEvidence, provider: "mews",
    pms: { async createBooking() { return { bookingId: "mews-987", status: "confirmed" }; } },
    async persistOutcome() { throw new Error("database unavailable"); },
  });
  assert.equal(result.state, "booking_pending");
  assert.equal(result.confirmed, false);
  assert.equal(result.requiresStaffReview, true);
  assert.equal(result.reason, "pms_outcome_persistence_unverified");
  assert.equal(result.pmsBookingId, "mews-987");
});

test("requires tenant-scoped persistence before calling the PMS", async () => {
  const { booking, paymentEvidence } = fixtures();
  let pmsCalls = 0;
  await assert.rejects(() => createAndPersistReservation({
    booking, paymentEvidence, provider: "mews",
    pms: { async createBooking() { pmsCalls += 1; return { bookingId: "res-1", status: "confirmed" }; } },
  }), e => e.code === "BOOKING_PERSISTENCE_REQUIRED");
  assert.equal(pmsCalls, 0);
});


test("does not confirm a guest when the persistence adapter resolves without reporting a committed state", async () => {
  const { booking, paymentEvidence } = fixtures();
  const result = await createAndPersistReservation({
    booking, bookingId: "booking-1", organizationId: "hotel-a",
    paymentEvidence, provider: "mews",
    pms: { async createBooking() { return { bookingId: "mews-987", status: "confirmed" }; } },
    async persistOutcome() { return undefined; },
  });
  assert.equal(result.state, "booking_pending");
  assert.equal(result.confirmed, false);
  assert.equal(result.requiresStaffReview, true);
  assert.equal(result.reason, "pms_outcome_persistence_unverified");
});
