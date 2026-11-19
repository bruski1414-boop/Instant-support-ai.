"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsDemoReservationIntegration } = require("../mews-demo-reservation-integration");

test("composes demo-only Mews availability and reservation adapters with durable ledger", async () => {
  const queries = [];
  const db = { async query(sql) { queries.push(sql); return { rowCount: 0, rows: [] }; } };
  const writer = await createMewsDemoReservationIntegration({
    organizationId: "hotel-demo",
    clientToken: "demo-client-token",
    accessToken: "demo-access-token",
    clientName: "Veyra demo",
    serviceId: "service-1",
    resourceCategoryId: "room-1",
    db,
    resolveTimeUnits: async () => ["2026-12-02T00:00:00Z"],
    resolveReservation: async () => ({
      customerId: "customer-1",
      rateId: "rate-1",
      roomTypeCode: "room-1",
      arrivalDate: "2026-12-02",
      departureDate: "2026-12-03",
      startUtc: "2026-12-02T14:00:00Z",
      endUtc: "2026-12-03T10:00:00Z"
    }),
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } })
  });
  assert.equal(writer.providerId, "mews");
  assert.equal(writer.tenantId, "hotel-demo");
  assert.equal(writer.supportsIdempotency, true);
  assert.deepEqual(writer.capabilities, ["availability", "reservations"]);
  assert.equal(queries.some(sql => sql.includes("CREATE TABLE IF NOT EXISTS mews_reservation_idempotency")), true);
});

test("requires hotel-approved timezone and guest/rate mapping callbacks", async () => {
  await assert.rejects(() => createMewsDemoReservationIntegration({
    organizationId: "hotel-demo",
    clientToken: "client",
    accessToken: "access",
    clientName: "Veyra demo",
    serviceId: "service-1",
    resourceCategoryId: "room-1",
    db: { query: async () => ({ rowCount: 0, rows: [] }) }
  }), /timezone and guest\/rate resolvers/);
});
