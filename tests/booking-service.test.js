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


const { getHotelAvailability } = require("../booking-service");

test("live availability uses only the tenant's connected PMS and decrypted credentials", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [{ provider: "mews", encrypted_credentials: "ciphertext" }] };
    },
  };
  let registryArgs;
  const result = await getHotelAvailability({
    db,
    organizationId: "hotel-a",
    checkIn: "2027-02-10",
    checkOut: "2027-02-12",
    guestCount: 3,
    vault: { decrypt(value) { assert.equal(value, "ciphertext"); return { accessToken: "secret" }; } },
    pmsRegistry: {
      async getAvailability(provider, dates, context) {
        registryArgs = { provider, dates, context };
        return [{ roomTypeId: "suite", roomTypeName: "Ocean Suite", currency: "THB", amountMinor: 125000, availableUnits: 2 }];
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ["hotel-a"]);
  assert.match(calls[0].sql, /organization_id=\$1 AND status='connected'/);
  assert.equal(registryArgs.provider, "mews");
  assert.deepEqual(registryArgs.dates, { checkIn: "2027-02-10", checkOut: "2027-02-12", guestCount: 3 });
  assert.deepEqual(registryArgs.context, { credentials: { accessToken: "secret" }, organizationId: "hotel-a" });
  assert.equal(result.status, "checked");
  assert.equal(result.rooms[0].availableUnits, 2);
  assert.ok(result.checkedAt);
});

test("missing PMS connection reports unknown rather than claiming sold out or available", async () => {
  let registryCalls = 0;
  const result = await getHotelAvailability({
    db: { async query(_sql, params) { assert.deepEqual(params, ["hotel-a"]); return { rowCount: 0, rows: [] }; } },
    organizationId: "hotel-a",
    checkIn: "2027-02-10",
    checkOut: "2027-02-12",
    vault: { decrypt() { throw new Error("must not decrypt"); } },
    pmsRegistry: { async getAvailability() { registryCalls += 1; return []; } },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "pms_connection_missing");
  assert.deepEqual(result.rooms, []);
  assert.equal(registryCalls, 0);
});

test("invalid date ranges are rejected before querying PMS connections", async () => {
  let queries = 0;
  await assert.rejects(() => getHotelAvailability({
    db: { async query() { queries += 1; return { rowCount: 0, rows: [] }; } },
    organizationId: "hotel-a",
    checkIn: "2027-02-12",
    checkOut: "2027-02-10",
    vault: { decrypt() { return {}; } },
    pmsRegistry: { async getAvailability() { return []; } },
  }), error => error.code === "INVALID_DATE_RANGE");
  assert.equal(queries, 0);
});

test("unavailable provider capability reports unknown instead of fake availability", async () => {
  const result = await getHotelAvailability({
    db: { async query() { return { rowCount: 1, rows: [{ provider: "sandbox", encrypted_credentials: "ciphertext" }] }; } },
    organizationId: "hotel-a",
    checkIn: "2027-02-10",
    checkOut: "2027-02-12",
    vault: { decrypt() { return {}; } },
    pmsRegistry: { async getAvailability() { throw Object.assign(new Error("unsupported"), { code: "CAPABILITY_UNAVAILABLE" }); } },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "pms_availability_not_ready");
  assert.deepEqual(result.rooms, []);
});


test("booking orchestrator can be constructed in demo mode but refuses invocation without a database", async () => {
  const orchestrator = createVerifiedDepositPmsOrchestrator({
    db: null,
    vault: { decrypt() { return {}; } },
    pmsRegistry: { async createBooking() { throw new Error("must not call"); } },
  });
  await assert.rejects(
    () => orchestrator({ organizationId: "hotel-a", bookingId: "booking-1" }),
    error => error.code === "PMS_ORCHESTRATOR_NOT_CONFIGURED"
  );
});


test("availability rejects invalid guest counts before reading a hotel's PMS connection", async () => {
  let queries = 0;
  await assert.rejects(() => getHotelAvailability({
    db: { async query() { queries += 1; return { rowCount: 0, rows: [] }; } },
    organizationId: "hotel-a",
    checkIn: "2027-02-10",
    checkOut: "2027-02-12",
    guestCount: 21,
    vault: { decrypt() { return {}; } },
    pmsRegistry: { async getAvailability() { return []; } },
  }), error => error.code === "INVALID_GUEST_COUNT");
  assert.equal(queries, 0);
});
