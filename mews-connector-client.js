"use strict";

/**
 * Read-only Mews Connector API transport.
 * Credentials must be supplied by the server-side credential vault.
 * This module deliberately exposes no reservation-write methods.
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

function requiredString(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(field + " is required.");
  }
  return value.trim();
}

function createMewsConnectorClient({
  environment,
  clientToken,
  accessToken,
  clientName,
  fetchImpl = globalThis.fetch,
  tenantId
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(BASE_URLS, environment)) {
    throw new Error("Mews environment must be demo or production.");
  }
  const safeTenantId = requiredString(tenantId, "tenantId", 128);
  const safeClientToken = requiredString(clientToken, "clientToken", 512);
  const safeAccessToken = requiredString(accessToken, "accessToken", 512);
  const safeClientName = requiredString(clientName, "clientName", 100);
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  async function post(operation, payload = {}) {
    const path = READ_OPERATIONS[operation];
    if (!path) throw new Error("Unsupported or write operation.");
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
    readOnly: true,
    getConfiguration: () => post("configuration"),
    getServices: (payload) => post("services", payload),
    getAvailability: (payload) => post("availability", payload),
    getReservations: (payload) => post("reservations", payload)
  });
}

module.exports = { createMewsConnectorClient, READ_OPERATIONS, BASE_URLS };
