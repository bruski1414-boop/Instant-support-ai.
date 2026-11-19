"use strict";

/**
 * Converts Mews daily service availability into Veyra's conservative
 * whole-stay availability result. The caller must supply UTC boundaries
 * calculated using the hotel's configured timezone and Mews service time unit.
 */
function requiredText(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(field + " is required.");
  }
  return value.trim();
}

function validIso(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new Error(field + " must be a UTC ISO-8601 timestamp.");
  }
  return value;
}

function createMewsAvailabilityAdapter({ client, tenantId, serviceId, resourceCategoryId, timeUnitStartsUtc } = {}) {
  if (!client || typeof client.getAvailability !== "function" || client.providerId !== "mews" || client.readOnly !== true) {
    throw new Error("A read-only Mews Connector API client is required.");
  }
  const safeTenant = requiredText(tenantId, "tenantId", 128);
  const safeService = requiredText(serviceId, "serviceId", 128);
  const safeCategory = requiredText(resourceCategoryId, "resourceCategoryId", 128);
  if (!Array.isArray(timeUnitStartsUtc) || timeUnitStartsUtc.length < 1 || timeUnitStartsUtc.length > 368) {
    throw new Error("Expected Mews time-unit boundaries are required.");
  }
  const expected = timeUnitStartsUtc.map((value, index) => validIso(value, "timeUnitStartsUtc[" + index + "]"));
  if (expected.some((value, index) => index > 0 && Date.parse(value) <= Date.parse(expected[index - 1]))) {
    throw new Error("Time-unit boundaries must be strictly increasing.");
  }

  return Object.freeze({
    providerId: "mews",
    tenantId: safeTenant,
    capabilities: Object.freeze(["availability"]),
    async checkAvailability({ arrivalDate, departureDate, roomTypeCode } = {}) {
      if (typeof arrivalDate !== "string" || typeof departureDate !== "string" || departureDate <= arrivalDate) {
        throw new Error("A valid arrival and departure date range is required.");
      }
      if (roomTypeCode !== safeCategory) throw new Error("Room type does not match the configured Mews resource category.");
      const response = await client.getAvailability({
        ServiceId: safeService,
        FirstTimeUnitStartUtc: expected[0],
        LastTimeUnitStartUtc: expected[expected.length - 1]
      });
      if (!response || !Array.isArray(response.TimeUnitStartsUtc) || !Array.isArray(response.CategoryAvailabilities)) {
        throw new Error("Mews availability response is incomplete.");
      }
      if (response.TimeUnitStartsUtc.length !== expected.length ||
          response.TimeUnitStartsUtc.some((value, index) => value !== expected[index])) {
        throw new Error("Mews returned unexpected time units; refusing to infer availability.");
      }
      const category = response.CategoryAvailabilities.find(item => item && item.CategoryId === safeCategory);
      if (!category || !Array.isArray(category.Availabilities) ||
          category.Availabilities.length !== expected.length ||
          category.Availabilities.some(value => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error("Mews did not return complete availability for the configured room category.");
      }
      return Object.freeze({
        organizationId: safeTenant,
        arrivalDate,
        departureDate,
        roomTypeCode: safeCategory,
        roomsAvailable: Math.min(...category.Availabilities),
        observedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
        source: "mews_connector_api"
      });
    }
  });
}

module.exports = { createMewsAvailabilityAdapter };
