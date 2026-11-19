"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsReservationWriter } = require("../mews-reservation-writer");

const request = {
  organizationId: "hotel-demo",
  idempotencyKey: "request_12345678901234567890",
  guest: { fullName: "Alex Morgan", phone: "+441234567890" },
  arrivalDate: "2026-12-02",
  departureDate: "2026-12-05",
  adults: 2,
  children: 1,
  roomTypeCode: "ocean-villa"
};

function setup(overrides = {}) {
  const calls = [];
  const ledger = new Map();
  const store = {
    durable: true,
    async claim(input) {
      calls.push(["claim", input]);
      const current = ledger.get(input.idempotencyKey);
      if (current) {
        if (current.requestHash !== input.requestHash) return { status: "conflict" };
        return current.status === "completed"
          ? { status: "completed", result: current.result }
          : { status: current.status };
      }
      ledger.set(input.idempotencyKey, { status: "in_progress", requestHash: input.requestHash });
      return { status: "acquired" };
    },
    async release(input) {
      calls.push(["release", input]);
      const current = ledger.get(input.idempotencyKey);
      if (!current || current.status !== "in_progress" || current.requestHash !== input.requestHash) {
        throw new Error("Cannot release reservation claim.");
      }
      ledger.delete(input.idempotencyKey);
    },
    async complete(input) {
      calls.push(["complete", input]);
      ledger.set(input.idempotencyKey, { status: "completed", requestHash: input.requestHash, result: input.result });
    },
    async markUncertain(input) {
      calls.push(["uncertain", input]);
      ledger.set(input.idempotencyKey, { status: "uncertain", requestHash: input.requestHash });
    }
  };
  const client = {
    providerId: "mews",
    tenantId: "hotel-demo",
    environment: "demo",
    writeEnabled: true,
    async addReservations(payload) {
      calls.push(["write", payload]);
      return {
        Reservations: [{
          Reservation: {
            Id: "mews-reservation-1",
            Number: "DEMO-1001",
            State: "Confirmed"
          }
        }]
      };
    },
    ...overrides.client
  };
  const availabilityAdapter = {
    organizationId: "hotel-demo",
    async checkAvailability(input) {
      return {
        organizationId: "hotel-demo",
        arrivalDate: input.arrivalDate,
        departureDate: input.departureDate,
        roomTypeCode: input.roomTypeCode,
        roomsAvailable: 1
      };
    }
  };
  const { client: clientOverrides, ...writerOverrides } = overrides;
  const writer = createMewsReservationWriter({
    client: { ...client, ...clientOverrides },
    tenantId: "hotel-demo",
    serviceId: "room-service",
    resourceCategoryId: "ocean-villa",
    availabilityAdapter,
    resolveReservation: async () => ({
      customerId: "mews-customer-1",
      rateId: "public-rate",
      roomTypeCode: "ocean-villa",
      startUtc: "2026-12-02T14:00:00Z",
      endUtc: "2026-12-05T10:00:00Z"
    }),
    idempotencyStore: store,
    ...writerOverrides
  });
  return { writer, calls, ledger };
}

test("requires an explicitly enabled demo client and durable atomic idempotency store", () => {
  assert.throws(() => setup({ idempotencyStore: { durable: false } }), /durable atomic idempotency store/);
  assert.throws(() => createMewsReservationWriter({
    client: { providerId: "mews", tenantId: "hotel-demo", environment: "production", writeEnabled: true, addReservations() {} },
    tenantId: "hotel-demo", serviceId: "service", resourceCategoryId: "category",
    availabilityAdapter: { organizationId: "hotel-demo", checkAvailability() {} },
    resolveReservation() {},
    idempotencyStore: { durable: true, claim() {}, complete() {}, markUncertain() {} }
  }), /demo client/);
});

test("writes one confirmed demo reservation and persists the idempotency result", async () => {
  const s = setup();
  const result = await s.writer.createReservation(request);
  assert.equal(result.confirmed, true);
  assert.equal(result.bookingReference, "DEMO-1001");
  assert.equal(result.providerReservationId, "mews-reservation-1");
  const write = s.calls.find(call => call[0] === "write")[1];
  assert.equal(write.CheckOverbooking, true);
  assert.equal(write.CheckRateApplicability, true);
  assert.equal(write.SendConfirmationEmail, false);
  assert.equal(write.Reservations[0].CustomerId, "mews-customer-1");
  assert.equal(s.calls.filter(call => call[0] === "complete").length, 1);
});

test("checks fresh exact availability before sending a reservation write", async () => {
  const s = setup();
  const result = await s.writer.createReservation(request);
  assert.equal(result.confirmed, true);
  assert.equal(s.calls.some(call => call[0] === "write"), true);
  assert.equal(s.calls.findIndex(call => call[0] === "claim") < s.calls.findIndex(call => call[0] === "write"), true);
});

test("rejects sold-out or mismatched availability and releases the claim without a provider write", async () => {
  const s = setup();
  // Replace the adapter method to simulate the provider reporting no inventory.
  const adapter = s.writer;
  const original = adapter.checkAvailability;
  adapter.checkAvailability = async () => ({
    organizationId: "hotel-demo",
    arrivalDate: request.arrivalDate,
    departureDate: request.departureDate,
    roomTypeCode: request.roomTypeCode,
    roomsAvailable: 0,
    observedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 30000).toISOString()
  });
  await assert.rejects(() => s.writer.createReservation(request), /Fresh, matching live room availability/);
  assert.equal(s.calls.some(call => call[0] === "write"), false);
  assert.equal(s.calls.some(call => call[0] === "release"), true);
  adapter.checkAvailability = original;
});

test("returns a completed idempotent result without sending a second Mews write", async () => {
  const s = setup();
  const first = await s.writer.createReservation(request);
  const second = await s.writer.createReservation(request);
  assert.deepEqual(second, first);
  assert.equal(s.calls.filter(call => call[0] === "write").length, 1);
});

test("blocks an in-progress or uncertain request rather than risking a duplicate booking", async () => {
  const s = setup();
  s.ledger.set(request.idempotencyKey, {
    status: "in_progress",
    requestHash: require("../mews-reservation-writer").stableRequestHash(request)
  });
  await assert.rejects(() => s.writer.createReservation(request), /already running or requires staff/);
  assert.equal(s.calls.some(call => call[0] === "write"), false);
});

test("marks a failed provider write uncertain and does not retry automatically", async () => {
  let writeCalls = 0;
  const s = setup({
    client: { async addReservations() { writeCalls += 1; throw new Error("network timeout"); } }
  });
  await assert.rejects(() => s.writer.createReservation(request), /outcome is uncertain/);
  assert.equal(s.calls.filter(call => call[0] === "uncertain").length, 1);
  await assert.rejects(() => s.writer.createReservation(request), /already running or requires staff/);
  assert.equal(writeCalls, 1);
});

test("marks incomplete or non-confirmed provider responses for staff reconciliation", async () => {
  const s = setup({
    client: { async addReservations() { return { Reservations: [{ Reservation: { Id: "id-only", State: "Pending" } }] }; } }
  });
  await assert.rejects(() => s.writer.createReservation(request), /no verifiable confirmed reservation/);
  assert.equal(s.calls.some(call => call[0] === "uncertain"), true);
});

test("rejects cross-tenant requests before the Mews write", async () => {
  const s = setup();
  await assert.rejects(() => s.writer.createReservation({ ...request, organizationId: "other-hotel" }), /tenant/);
  assert.equal(s.calls.some(call => call[0] === "write"), false);
});
