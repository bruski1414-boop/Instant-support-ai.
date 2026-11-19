"use strict";

/**
 * Converts Mews daily service availability into Veyra's conservative
 * whole-stay result. The hotel-specific resolver must convert local check-in
 * and check-out dates into the property's actual UTC day-unit boundaries.
 * Veyra intentionally does not guess a hotel's timezone or DST rules.
 */
function requiredText(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(field + " is required.");
  }
  return value.trim();
}

function validDate(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(field + " must use YYYY-MM-DD.");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(field + " must be a real calendar date.");
  }
  return value;
}

function nightsBetween(arrivalDate, departureDate) {
  return (Date.parse(departureDate + "T00:00:00.000Z") -
    Date.parse(arrivalDate + "T00:00:00.000Z")) / 86400000;
}

function validIso(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new Error(field + " must be a UTC ISO-8601 timestamp.");
  }
  return value;
}

function createMewsAvailabilityAdapter({
  client, tenantId, serviceId, resourceCategoryId, resolveTimeUnits
} = {}) {
  if (!client || typeof client.getAvailability !== "function" || client.providerId !== "mews" || client.readOnly !== true) {
    throw new Error("A read-only Mews Connector API client is required.");
  }
  const safeTenant = requiredText(tenantId, "tenantId", 128);
  const safeService = requiredText(serviceId, "serviceId", 128);
  const safeCategory = requiredText(resourceCategoryId, "resourceCategoryId", 128);
  if (typeof resolveTimeUnits !== "function") {
    throw new Error("A hotel-timezone-aware time-unit resolver is required.");
  }

  return Object.freeze({
    providerId: "mews",
    tenantId: safeTenant,
    organizationId: safeTenant,
    capabilities: Object.freeze(["availability"]),
    async checkAvailability({ arrivalDate, departureDate, roomTypeCode } = {}) {
      const arrival = validDate(arrivalDate, "arrivalDate");
      const departure = validDate(departureDate, "departureDate");
      const nights = nightsBetween(arrival, departure);
      if (!Number.isInteger(nights) || nights < 1 || nights > 367) {
        throw new Error("Stay must contain between 1 and 367 nights.");
      }
      if (roomTypeCode !== safeCategory) throw new Error("Room type does not match the configured Mews resource category.");

      const boundaries = await resolveTimeUnits({ arrivalDate: arrival, departureDate: departure });
      if (!Array.isArray(boundaries) || boundaries.length !== nights) {
        throw new Error("Hotel timezone mapping must return exactly one Mews day-unit boundary per night.");
      }
      const expected = boundaries.map((value, index) => validIso(value, "timeUnitStartsUtc[" + index + "]"));
      if (expected.some((value, index) => index > 0 && Date.parse(value) <= Date.parse(expected[index - 1]))) {
        throw new Error("Mews time-unit boundaries must be strictly increasing.");
      }

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

      const observedAt = new Date().toISOString();
      return Object.freeze({
        organizationId: safeTenant,
        arrivalDate: arrival,
        departureDate: departure,
        roomTypeCode: safeCategory,
        roomsAvailable: Math.min(...category.Availabilities),
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 60_000).toISOString(),
        source: "mews_connector_api"
      });
    },
    // The registry contract calls this capability "availability"; keep the
    // booking-service method name as an alias for provider-neutral orchestration.
    async availability(input) {
      return this.checkAvailability(input);
    }
  });
}

module.exports = { createMewsAvailabilityAdapter };
