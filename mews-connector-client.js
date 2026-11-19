"use strict";

/**
 * Mews Connector API transport.
 * Credentials are supplied by the server-side credential vault.
 * Reservation writes are disabled by default and can only be enabled against
 * the Mews demo environment. This transport does not claim idempotency:
 * callers must wrap writes in a durable, atomic idempotency ledger and must
 * reconcile ambiguous timeouts before retrying.
 */

const BASE_URLS = Object.freeze({
  demo: "https://api.mews-demo.com",
  production: "https://api.mews.com"
});

const READ_OPERATIONS = Object.freeze({
  configuration: "configuration/get",
  services: "services/getAll",
  availability: "services/getAvailability",
  reservations: "reservations/getAll/2023-06-06"
});

const WRITE_OPERATIONS = Object.freeze({
  addReservations: "reservations/add"
});

function requiredString(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(field + " is required.");
  }
  return value.trim();
}

function validateAddReservationsPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Mews reservation payload must be an object.");
  }
  const serviceId = requiredString(payload.ServiceId, "ServiceId", 128);
  if (!Array.isArray(payload.Reservations) || payload.Reservations.length !== 1) {
    throw new Error("Exactly one reservation must be submitted per idempotency-ledger operation.");
  }
  const reservation = payload.Reservations[0];
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    throw new Error("A reservation parameter object is required.");
  }
  for (const field of ["CustomerId", "RequestedCategoryId", "RateId"]) {
    requiredString(reservation[field], field, 128);
  }
  for (const field of ["StartUtc", "EndUtc"]) {
    const value = reservation[field];
    if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$/.test(value) ||
        !Number.isFinite(Date.parse(value))) {
      throw new Error(field + " must be a UTC ISO-8601 timestamp.");
    }
  }
  if (Date.parse(reservation.EndUtc) <= Date.parse(reservation.StartUtc)) {
    throw new Error("EndUtc must be after StartUtc.");
  }
  if (!reservation.PersonCounts || typeof reservation.PersonCounts !== "object" ||
      !Number.isInteger(reservation.PersonCounts.AdultCount) || reservation.PersonCounts.AdultCount < 1 ||
      !Number.isInteger(reservation.PersonCounts.ChildCount) || reservation.PersonCounts.ChildCount < 0) {
    throw new Error("PersonCounts must include valid adult and child counts.");
  }
  return {
    ServiceId: serviceId,
    Reservations: [{
      CustomerId: reservation.CustomerId.trim(),
      RequestedCategoryId: reservation.RequestedCategoryId.trim(),
      RateId: reservation.RateId.trim(),
      StartUtc: reservation.StartUtc,
      EndUtc: reservation.EndUtc,
      PersonCounts: {
        AdultCount: reservation.PersonCounts.AdultCount,
        ChildCount: reservation.PersonCounts.ChildCount
      },
      State: "Confirmed"
    }],
    CheckRateApplicability: true,
    CheckOverbooking: true,
    SendConfirmationEmail: false
  };
}

function createMewsConnectorClient({
  environment,
  clientToken,
  accessToken,
  clientName,
  fetchImpl = globalThis.fetch,
  tenantId,
  allowReservationWrites = false
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(BASE_URLS, environment)) {
    throw new Error("Mews environment must be demo or production.");
  }
  if (allowReservationWrites !== true && allowReservationWrites !== false) {
    throw new Error("allowReservationWrites must be an explicit boolean.");
  }
  if (allowReservationWrites && environment !== "demo") {
    throw new Error("Reservation writes are restricted to the Mews demo environment in this integration.");
  }
  const safeTenantId = requiredString(tenantId, "tenantId", 128);
  const safeClientToken = requiredString(clientToken, "clientToken", 512);
  const safeAccessToken = requiredString(accessToken, "accessToken", 512);
  const safeClientName = requiredString(clientName, "clientName", 100);
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  async function post(operation, payload = {}, write = false) {
    const path = (write ? WRITE_OPERATIONS : READ_OPERATIONS)[operation];
    if (!path) throw new Error("Unsupported or disabled operation.");
    if (write && !allowReservationWrites) throw new Error("Reservation writes are disabled.");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Mews request payload must be an object.");
    }
    for (const key of ["ClientToken", "AccessToken", "Client"]) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        throw new Error("Authentication fields are managed by the connector.");
      }
    }

    const response = await fetchImpl(BASE_URLS[environment] + "/api/connector/v1/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({
        ClientToken: safeClientToken,
        AccessToken: safeAccessToken,
        Client: safeClientName,
        ...payload
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response || typeof response.ok !== "boolean") {
      throw new Error("Mews returned an invalid transport response.");
    }
    if (!response.ok) {
      const error = new Error("Mews request failed with HTTP " + response.status + ".");
      error.status = response.status;
      if (response.status === 429) error.retryAfter = response.headers?.get?.("retry-after") || null;
      throw error;
    }
    if (response.status === 204) return {};
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Mews returned an invalid JSON response.");
    }
    return result;
  }

  return Object.freeze({
    providerId: "mews",
    tenantId: safeTenantId,
    environment,
    readOnly: !allowReservationWrites,
    writeEnabled: allowReservationWrites,
    // Mews reservations/add does not expose an idempotency-key field.
    supportsIdempotency: false,
    getConfiguration: () => post("configuration"),
    getServices: (payload) => post("services", payload),
    getAvailability: (payload) => post("availability", payload),
    getReservations: (payload) => post("reservations", payload),
    addReservations: (payload) => {
      const safePayload = validateAddReservationsPayload(payload);
      return post("addReservations", safePayload, true);
    }
  });
}

module.exports = {
  createMewsConnectorClient,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
  BASE_URLS,
  validateAddReservationsPayload
};
