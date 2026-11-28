"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAndPersistReservation, createVerifiedDepositPmsOrchestrator } = require("../booking-service");

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


test("does not confirm a guest when persisted state differs from the PMS outcome", async () => {
  const { booking, paymentEvidence } = fixtures();
  const result = await createAndPersistReservation({
    booking, bookingId: "booking-1", organizationId: "hotel-a",
    paymentEvidence, provider: "mews",
    pms: { async createBooking() { return { bookingId: "mews-987", status: "confirmed" }; } },
    async persistOutcome() { return { state: "booking_pending", duplicate: false }; },
  });
  assert.equal(result.state, "booking_pending");
  assert.equal(result.confirmed, false);
  assert.equal(result.requiresStaffReview, true);
  assert.equal(result.reason, "pms_outcome_persistence_unverified");
});


function orchestratorDb({ bookingState = "payment_verified", connection = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM hotel_bookings")) {
        return { rowCount: bookingState ? 1 : 0, rows: bookingState ? [{ state: bookingState }] : [] };
      }
      if (sql.includes("FROM pms_connections")) {
        return { rowCount: connection ? 1 : 0, rows: connection ? [connection] : [] };
      }
      throw new Error("Unexpected SQL: " + sql);
    },
  };
}

test("verified deposit with no connected PMS stays unconfirmed for staff review", async () => {
  const db = orchestratorDb();
  let reservationCalls = 0;
  const orchestrate = createVerifiedDepositPmsOrchestrator({
    db, vault: { decrypt() { throw new Error("must not decrypt"); } },
    pmsRegistry: {},
    async createReservation() { reservationCalls += 1; },
  });
  const result = await orchestrate({ organizationId: "hotel-a", bookingId: "booking-1" });
  assert.equal(result.state, "payment_verified");
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, "pms_connection_missing");
  assert.equal(reservationCalls, 0);
  assert.equal(db.calls[0].params[1], "hotel-a");
});

test("connected unsupported PMS cannot confirm and is returned as pending for review", async () => {
  const db = orchestratorDb({ connection: { provider: "unsupported_pms", encrypted_credentials: "ciphertext" } });
  let received;
  const orchestrate = createVerifiedDepositPmsOrchestrator({
    db,
    vault: { configured: true, decrypt(value) { assert.equal(value, "ciphertext"); return { apiKey: "secret" }; } },
    pmsRegistry: { async createBooking() { throw Object.assign(new Error("adapter missing"), { code: "PMS_PROVIDER_NOT_SUPPORTED" }); } },
    async createReservation(args) {
      received = args;
      await assert.rejects(() => args.pms.createBooking(args.provider, {}, args.context), /adapter missing/);
      return { state: "booking_pending", confirmed: false, requiresStaffReview: true, reason: "pms_provider_not_supported" };
    },
  });
  const result = await orchestrate({ organizationId: "hotel-a", bookingId: "booking-1" });
  assert.equal(received.provider, "unsupported_pms");
  assert.deepEqual(received.context.credentials, { apiKey: "secret" });
  assert.equal(result.state, "booking_pending");
  assert.equal(result.confirmed, false);
});

test("only a confirmed reservation result from the reservation service can be surfaced as confirmed", async () => {
  const db = orchestratorDb({ connection: { provider: "mews", encrypted_credentials: "ciphertext" } });
  const orchestrate = createVerifiedDepositPmsOrchestrator({
    db,
    vault: { configured: true, decrypt: () => ({ token: "hotel-token" }) },
    pmsRegistry: { async createBooking() { return { bookingId: "res-77", status: "confirmed" }; } },
    async createReservation(args) {
      const pmsResult = await args.pms.createBooking(args.provider, { roomTypeId: "suite" }, args.context);
      assert.equal(pmsResult.status, "confirmed");
      return { state: "confirmed", confirmed: true, pmsBookingId: pmsResult.bookingId };
    },
  });
  const result = await orchestrate({ organizationId: "hotel-a", bookingId: "booking-1" });
  assert.deepEqual(result, { state: "confirmed", confirmed: true, pmsBookingId: "res-77" });
});

test("PMS timeout remains pending and is never surfaced as a guest confirmation", async () => {
  const db = orchestratorDb({ connection: { provider: "mews", encrypted_credentials: "ciphertext" } });
  const orchestrate = createVerifiedDepositPmsOrchestrator({
    db,
    vault: { configured: true, decrypt: () => ({ token: "hotel-token" }) },
    pmsRegistry: { async createBooking() { throw new Error("network timeout"); } },
    async createReservation(args) {
      await assert.rejects(() => args.pms.createBooking(args.provider, {}, args.context), /network timeout/);
      return { state: "booking_pending", confirmed: false, requiresStaffReview: true, reason: "pms_result_unknown" };
    },
  });
  const result = await orchestrate({ organizationId: "hotel-a", bookingId: "booking-1" });
  assert.equal(result.state, "booking_pending");
  assert.equal(result.confirmed, false);
  assert.equal(result.requiresStaffReview, true);
});

test("does not retry bookings already pending or query another PMS connection", async () => {
  const db = orchestratorDb({ bookingState: "booking_pending" });
  let reservationCalls = 0;
  const orchestrate = createVerifiedDepositPmsOrchestrator({
    db, vault: {}, pmsRegistry: {},
    async createReservation() { reservationCalls += 1; },
  });
  const result = await orchestrate({ organizationId: "hotel-a", bookingId: "booking-1" });
  assert.equal(result.state, "booking_pending");
  assert.equal(result.requiresStaffReview, true);
  assert.equal(reservationCalls, 0);
  assert.equal(db.calls.length, 1);
});
