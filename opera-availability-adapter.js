"use strict";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FRESHNESS_MS = 5 * 60 * 1000;

function validDate(value, field) {
  if (typeof value !== "string" || !DATE.test(value)) throw new Error(field + " must use YYYY-MM-DD.");
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(field + " must be a real calendar date.");
  }
  return value;
}

function cleanText(value, field, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max ||
      /[\u0000-\u001f\u007f]/.test(value)) throw new Error(field + " is invalid.");
  return value.trim();
}

/**
 * Bridges OHIP's hotel-specific raw response to Veyra's canonical availability
 * contract. The mapper is deliberately injected: only hotel/vendor-approved
 * response fixtures and room/rate configuration can define this mapping.
 */
function createOperaAvailabilityAdapter({
  client,
  tenantId,
  mapAvailabilityResponse,
  now = () => new Date()
} = {}) {
  if (!client || client.providerId !== "oracle_opera" || client.readOnly !== true ||
      typeof client.getHotelAvailability !== "function") {
    throw new Error("A read-only Oracle OPERA availability client is required.");
  }
  const safeTenantId = cleanText(tenantId, "tenantId", 128);
  if (typeof mapAvailabilityResponse !== "function") {
    throw new Error("A hotel-approved OPERA response mapper is required.");
  }

  const adapter = {
    providerId: "oracle_opera",
    tenantId: safeTenantId,
    organizationId: safeTenantId,
    capabilities: Object.freeze(["availability"]),

    async availability(input = {}) {
      const arrivalDate = validDate(input.arrivalDate, "arrivalDate");
      const departureDate = validDate(input.departureDate, "departureDate");
      if (departureDate <= arrivalDate) throw new Error("departureDate must be after arrivalDate.");
      const roomTypeCode = cleanText(input.roomTypeCode, "roomTypeCode", 80);
      if (!Number.isInteger(input.adults) || input.adults < 1 || input.adults > 20) {
        throw new Error("adults must be from 1 to 20.");
      }
      const children = input.children == null ? 0 : input.children;
      if (!Number.isInteger(children) || children < 0 || children > 20) {
        throw new Error("children must be from 0 to 20.");
      }
      if (input.organizationId !== safeTenantId) throw new Error("Tenant identity does not match the configured hotel.");

      const raw = await client.getHotelAvailability({
        roomStayStartDate: arrivalDate,
        roomStayEndDate: departureDate,
        adults: input.adults,
        children,
        roomStayQuantity: 1,
        limit: 100,
        roomType: roomTypeCode
      });
      const mapped = await mapAvailabilityResponse(raw, Object.freeze({
        tenantId: safeTenantId,
        arrivalDate,
        departureDate,
        roomTypeCode,
        adults: input.adults,
        children
      }));
      if (!mapped || typeof mapped !== "object" || Array.isArray(mapped)) {
        throw new Error("OPERA response mapper returned an invalid result.");
      }
      if (mapped.organizationId !== safeTenantId ||
          mapped.arrivalDate !== arrivalDate ||
          mapped.departureDate !== departureDate ||
          mapped.roomTypeCode !== roomTypeCode ||
          !Number.isSafeInteger(mapped.roomsAvailable) ||
          mapped.roomsAvailable < 0) {
        throw new Error("OPERA response could not be verified against the requested hotel stay.");
      }
      const observedAt = Date.parse(mapped.observedAt);
      const validUntil = Date.parse(mapped.validUntil);
      const current = now();
      if (!(current instanceof Date) || !Number.isFinite(current.getTime()) ||
          !Number.isFinite(observedAt) || !Number.isFinite(validUntil) ||
          observedAt > current.getTime() || validUntil <= current.getTime() ||
          validUntil <= observedAt || validUntil - observedAt > MAX_FRESHNESS_MS) {
        throw new Error("OPERA availability freshness could not be verified.");
      }
      return Object.freeze({
        organizationId: safeTenantId,
        arrivalDate,
        departureDate,
        roomTypeCode,
        roomsAvailable: mapped.roomsAvailable,
        observedAt: new Date(observedAt).toISOString(),
        validUntil: new Date(validUntil).toISOString(),
        source: "oracle_opera_ohip"
      });
    },

    // Match the shared provider-neutral reservation service contract.
    async checkAvailability(input = {}) {
      return adapter.availability(input);
    }
  };
  return Object.freeze(adapter);
}

module.exports = { createOperaAvailabilityAdapter };
