"use strict";

const { createMewsConnectorClient } = require("./mews-connector-client");
const { createMewsAvailabilityAdapter } = require("./mews-availability-adapter");
const { createMewsReservationWriter } = require("./mews-reservation-writer");
const { createPostgresMewsIdempotencyStore } = require("./mews-reservation-idempotency-store");

/**
 * Composes the demo-only Mews read/write clients, live availability adapter,
 * PostgreSQL idempotency ledger and hotel-approved reservation resolver.
 * This deliberately cannot create a production writer.
 */
async function createMewsDemoReservationIntegration({
  organizationId, clientToken, accessToken, clientName, serviceId,
  resourceCategoryId, db, resolveTimeUnits, resolveReservation,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof organizationId !== "string" || !organizationId.trim()) {
    throw new Error("A hotel organization ID is required.");
  }
  if (!db || typeof db.query !== "function") {
    throw new Error("A PostgreSQL database client is required.");
  }
  if (typeof resolveTimeUnits !== "function" || typeof resolveReservation !== "function") {
    throw new Error("Hotel-approved timezone and guest/rate resolvers are required.");
  }

  const shared = {
    environment: "demo", clientToken, accessToken, clientName,
    tenantId: organizationId, fetchImpl
  };
  const readClient = createMewsConnectorClient({ ...shared, allowReservationWrites: false });
  const writeClient = createMewsConnectorClient({ ...shared, allowReservationWrites: true });
  const availabilityAdapter = createMewsAvailabilityAdapter({
    client: readClient, tenantId: organizationId, serviceId,
    resourceCategoryId, resolveTimeUnits
  });
  const idempotencyStore = createPostgresMewsIdempotencyStore({ db });
  await idempotencyStore.ensureSchema();

  return createMewsReservationWriter({
    client: writeClient, tenantId: organizationId, serviceId,
    resourceCategoryId, availabilityAdapter, resolveReservation, idempotencyStore
  });
}

module.exports = { createMewsDemoReservationIntegration };
