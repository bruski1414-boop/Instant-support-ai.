"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsConnectorClient } = require("../mews-connector-client");

function makeClient(fetchImpl, overrides = {}) {
  return createMewsConnectorClient({
    environment: "demo",
    clientToken: "demo-client-token",
    accessToken: "demo-property-token",
    clientName: "Veyra AI Test",
    tenantId: "hotel-demo",
    fetchImpl,
    ...overrides
  });
}

const validReservation = {
  ServiceId: "room-service",
  Reservations: [{
    CustomerId: "customer-123",
    RequestedCategoryId: "ocean-villa",
    RateId: "public-rate",
    StartUtc: "2026-12-02T14:00:00Z",
    EndUtc: "2026-12-05T10:00:00Z",
    PersonCounts: { AdultCount: 2, ChildCount: 1 }
  }]
};

test("uses Mews demo host and adds credentials server-side", async () => {
  let call;
  const client = makeClient(async (url, options) => {
    call = { url, options };
    return { ok: true, status: 200, json: async () => ({ Enterprise: { Id: "demo-id" } }) };
  });
  const result = await client.getConfiguration();
  assert.equal(call.url, "https://api.mews-demo.com/api/connector/v1/configuration/get");
  const body = JSON.parse(call.options.body);
  assert.equal(body.ClientToken, "demo-client-token");
  assert.equal(body.AccessToken, "demo-property-token");
  assert.equal(body.Client, "Veyra AI Test");
  assert.equal(result.Enterprise.Id, "demo-id");
  assert.equal(client.readOnly, true);
  assert.equal(client.supportsIdempotency, false);
});

test("supports documented read-only availability request", async () => {
  let body;
  const client = makeClient(async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ CategoryAvailabilities: [] }) };
  });
  await client.getAvailability({
    ServiceId: "service-id",
    FirstTimeUnitStartUtc: "2026-12-02T00:00:00Z",
    LastTimeUnitStartUtc: "2026-12-04T00:00:00Z"
  });
  assert.equal(body.ServiceId, "service-id");
  assert.equal(body.FirstTimeUnitStartUtc, "2026-12-02T00:00:00Z");
});

test("rejects credential overrides and keeps reservation writes disabled by default", async () => {
  const client = makeClient(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  await assert.rejects(() => client.getServices({ ClientToken: "attacker-value" }), /managed by the connector/);
  await assert.rejects(() => client.getServices([]), /must be an object/);
  await assert.rejects(() => client.addReservations(validReservation), /writes are disabled/);
  assert.equal(client.readOnly, true);
});

test("permits a single validated reservation write only when explicitly enabled in demo", async () => {
  let call;
  const client = makeClient(async (url, options) => {
    call = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ Reservations: [{ Reservation: { Id: "reservation-1", Number: "D-100" } }] })
    };
  }, { allowReservationWrites: true });
  const result = await client.addReservations(validReservation);
  assert.equal(call.url, "https://api.mews-demo.com/api/connector/v1/reservations/add");
  assert.equal(call.body.CheckOverbooking, true);
  assert.equal(call.body.CheckRateApplicability, true);
  assert.equal(call.body.SendConfirmationEmail, false);
  assert.equal(result.Reservations[0].Reservation.Id, "reservation-1");
  assert.equal(client.readOnly, false);
  assert.equal(client.writeEnabled, true);
  assert.equal(client.supportsIdempotency, false);
});

test("does not allow reservation writes against production", () => {
  assert.throws(() => makeClient(async () => ({}), {
    environment: "production",
    allowReservationWrites: true
  }), /restricted to the Mews demo/);
});

test("rejects malformed reservation data before making a provider call", async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  }, { allowReservationWrites: true });
  await assert.rejects(() => client.addReservations({
    ...validReservation,
    Reservations: [{ ...validReservation.Reservations[0], EndUtc: "2026-12-01T10:00:00Z" }]
  }), /after StartUtc/);
  await assert.rejects(() => client.addReservations({
    ...validReservation,
    Reservations: [{ ...validReservation.Reservations[0], PersonCounts: { AdultCount: 0, ChildCount: -1 } }]
  }), /PersonCounts/);
  await assert.rejects(() => client.addReservations({
    ...validReservation,
    Reservations: [{ ...validReservation.Reservations[0], CustomerId: " " }]
  }), /CustomerId/);
  await assert.rejects(() => client.addReservations({
    ...validReservation,
    Reservations: [validReservation.Reservations[0], validReservation.Reservations[0]]
  }), /Exactly one reservation/);
  assert.equal(calls, 0);
});

test("rejects invalid environment and missing tenant identity", () => {
  assert.throws(() => makeClient(async () => ({}), { environment: "unknown" }), /environment/);
  assert.throws(() => makeClient(async () => ({}), { tenantId: "" }), /tenantId/);
});

test("surfaces rate limiting without retrying a potentially unsafe request", async () => {
  const client = makeClient(async () => ({
    ok: false,
    status: 429,
    headers: { get: () => "5" }
  }), { allowReservationWrites: true });
  await assert.rejects(
    () => client.addReservations(validReservation),
    error => error.status === 429 && error.retryAfter === "5"
  );
});
