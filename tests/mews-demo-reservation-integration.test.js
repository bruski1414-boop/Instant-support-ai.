"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsDemoReservationIntegration } = require("../mews-demo-reservation-integration");

test("composes demo-only Mews availability and reservation adapters with durable ledger", async () => {
  const queries = [];
  const db = { async query(sql) { queries.push(sql); return { rowCount: 0, rows: [] }; } };
  const writer = await createMewsDemoReservationIntegration({
    organizationId: "hotel-demo", clientToken: "demo-client-token",
    accessToken: "demo-access-token", clientName: "Veyra demo",
    serviceId: "service-1", resourceCategoryId: "room-1", db,
    resolveTimeUnits: async () => ["2026-12-02T00:00:00Z"],
    resolveReservation: async () => ({
      customerId: "customer-1", rateId: "rate-1", roomTypeCode: "room-1",
      arrivalDate: "2026-12-02", departureDate: "2026-12-03",
      startUtc: "2026-12-02T14:00:00Z", endUtc: "2026-12-03T10:00:00Z"
    }),
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } })
  });
  assert.equal(writer.providerId, "mews");
  assert.equal(writer.tenantId, "hotel-demo");
  assert.equal(writer.supportsIdempotency, true);
  assert.deepEqual(writer.capabilities, ["availability", "reservations"]);
  assert.equal(queries.some(sql => sql.includes("CREATE TABLE IF NOT EXISTS mews_reservation_idempotency")), true);
});

test("performs a fully mocked demo availability check and confirmed reservation through the composed adapter", async () => {
  const queries = [];
  const db = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith("INSERT INTO mews_reservation_idempotency")) return { rowCount: 1, rows: [{ status: "in_progress" }] };
      if (sql.startsWith("UPDATE mews_reservation_idempotency SET status='completed'")) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    }
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith("/services/getAvailability")) {
      return { ok: true, status: 200, async json() {
        return { TimeUnitStartsUtc: ["2026-12-02T00:00:00Z"],
          CategoryAvailabilities: [{ CategoryId: "room-1", Availabilities: [2] }] };
      }};
    }
    if (url.endsWith("/reservations/add")) {
      return { ok: true, status: 200, async json() {
        return { Reservations: [{ Reservation: { Id: "demo-id-1", Number: "DEMO-2001", State: "Confirmed" } }] };
      }};
    }
    throw new Error("Unexpected Mews operation");
  };
  const writer = await createMewsDemoReservationIntegration({
    organizationId: "hotel-demo", clientToken: "demo-client-token",
    accessToken: "demo-access-token", clientName: "Veyra demo",
    serviceId: "service-1", resourceCategoryId: "room-1", db,
    resolveTimeUnits: async () => ["2026-12-02T00:00:00Z"],
    resolveReservation: async () => ({
      customerId: "customer-1", rateId: "rate-1", roomTypeCode: "room-1",
      arrivalDate: "2026-12-02", departureDate: "2026-12-03",
      startUtc: "2026-12-02T14:00:00Z", endUtc: "2026-12-03T10:00:00Z"
    }),
    fetchImpl
  });
  const result = await writer.createReservation({
    organizationId: "hotel-demo", idempotencyKey: "demo_request_123456789012345",
    guest: { fullName: "Alex Morgan", phone: "+441234567890" },
    consentToShareDetails: true, arrivalDate: "2026-12-02",
    departureDate: "2026-12-03", adults: 2, children: 0, roomTypeCode: "room-1"
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.bookingReference, "DEMO-2001");
  assert.equal(requests.length, 2);
  assert.ok(requests[0].url.endsWith("/services/getAvailability"));
  assert.ok(requests[1].url.endsWith("/reservations/add"));
  assert.equal(requests[1].body.CheckOverbooking, true);
  assert.equal(requests[1].body.SendConfirmationEmail, false);
});

test("requires hotel-approved timezone and guest/rate mapping callbacks", async () => {
  await assert.rejects(() => createMewsDemoReservationIntegration({
    organizationId: "hotel-demo", clientToken: "client", accessToken: "access",
    clientName: "Veyra demo", serviceId: "service-1", resourceCategoryId: "room-1",
    db: { query: async () => ({ rowCount: 0, rows: [] }) }
  }), /timezone and guest\/rate resolvers/);
});
