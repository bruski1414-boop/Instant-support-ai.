"use strict";

const { createOperaOhipReadOnlyClient } = require("./opera-ohip-readonly-client");
const { createOperaAvailabilityAdapter } = require("./opera-availability-adapter");
const { createPmsAdapterRegistry } = require("./pms-provider-registry");

/**
 * Composes an OPERA Cloud non-production, read-only availability connection.
 * It deliberately has no reservation-write or production mode.
 *
 * Credentials and the token provider must come from trusted server-side
 * configuration. The mapper must be approved against the hotel's own OHIP
 * API subscription and response fixtures.
 */
function createOperaOhipAvailabilityIntegration({
  organizationId,
  environment,
  approved,
  gatewayUrl,
  appKey,
  hotelId,
  getAccessToken,
  mapAvailabilityResponse,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  registry = createPmsAdapterRegistry()
} = {}) {
  if (environment !== "nonproduction") {
    throw new Error("This OPERA integration factory is restricted to non-production environments.");
  }
  if (approved !== true) {
    throw new Error("Hotel approval is required before registering an OPERA adapter.");
  }
  if (typeof organizationId !== "string" || !organizationId.trim()) {
    throw new Error("A hotel organization ID is required.");
  }
  if (!registry || typeof registry.register !== "function" || typeof registry.get !== "function") {
    throw new Error("A valid PMS adapter registry is required.");
  }

  const client = createOperaOhipReadOnlyClient({
    gatewayUrl, appKey, hotelId, getAccessToken, fetchImpl
  });
  const adapter = createOperaAvailabilityAdapter({
    client, tenantId: organizationId, mapAvailabilityResponse, now
  });
  const registration = registry.register({
    providerId: "oracle_opera",
    tenantId: organizationId,
    adapter,
    approved: true
  });

  return Object.freeze({
    providerId: "oracle_opera",
    organizationId,
    environment: "nonproduction",
    readOnly: true,
    client,
    adapter,
    registry,
    registration
  });
}

module.exports = { createOperaOhipAvailabilityIntegration };
