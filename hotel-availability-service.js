"use strict";

const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;
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
      /[\\u0000-\\u001f\\u007f]/.test(value)) throw new Error(field + " is invalid.");
  return value.trim();
}

/**
 * Provider-neutral, read-only availability service. Tenant and provider are
 * fixed by trusted server configuration, never selected by a guest request.
 * It deliberately cannot create, update, or cancel reservations.
 */
function createHotelAvailabilityService({
  registry,
  providerId,
  organizationId,
  now = () => new Date()
} = {}) {
  if (!registry || typeof registry.get !== "function") throw new Error("An approved PMS adapter registry is required.");
  const safeProviderId = cleanText(providerId, "providerId", 80);
  const safeOrganizationId = cleanText(organizationId, "organizationId", 128);

  return Object.freeze({
    async check(input = {}) {
      let request;
      try {
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
        request = { arrivalDate, departureDate, roomTypeCode, adults: input.adults, children };
      } catch {
        return Object.freeze({ status: "staff_handoff", reason: "invalid_availability_request" });
      }

      const adapter = registry.get({
        providerId: safeProviderId,
        tenantId: safeOrganizationId,
        requiredCapabilities: ["availability"]
      });
      if (!adapter || adapter.tenantId !== safeOrganizationId ||
          adapter.providerId !== safeProviderId ||
          typeof adapter.checkAvailability !== "function") {
        return Object.freeze({ status: "staff_handoff", reason: "availability_provider_not_configured" });
      }

      let inventory;
      try {
        inventory = await adapter.checkAvailability({
          organizationId: safeOrganizationId,
          ...request
        });
      } catch {
        return Object.freeze({ status: "staff_handoff", reason: "availability_check_failed" });
      }

      const checkedAt = now();
      if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime()) ||
          !inventory || typeof inventory !== "object" ||
          inventory.organizationId !== safeOrganizationId ||
          inventory.arrivalDate !== request.arrivalDate ||
          inventory.departureDate !== request.departureDate ||
          inventory.roomTypeCode !== request.roomTypeCode ||
          !Number.isSafeInteger(inventory.roomsAvailable) || inventory.roomsAvailable < 0) {
        return Object.freeze({ status: "staff_handoff", reason: "unverified_inventory" });
      }

      const observedAt = Date.parse(inventory.observedAt);
      const validUntil = Date.parse(inventory.validUntil);
      const current = checkedAt.getTime();
      if (!Number.isFinite(observedAt) || !Number.isFinite(validUntil) ||
          observedAt > current || current - observedAt > MAX_FRESHNESS_MS ||
          validUntil <= current || validUntil <= observedAt ||
          validUntil - observedAt > MAX_FRESHNESS_MS) {
        return Object.freeze({ status: "staff_handoff", reason: "stale_inventory" });
      }

      return Object.freeze({
        status: inventory.roomsAvailable > 0 ? "available" : "unavailable",
        providerId: safeProviderId,
        organizationId: safeOrganizationId,
        arrivalDate: request.arrivalDate,
        departureDate: request.departureDate,
        roomTypeCode: request.roomTypeCode,
        roomsAvailable: inventory.roomsAvailable,
        observedAt: new Date(observedAt).toISOString(),
        validUntil: new Date(validUntil).toISOString()
      });
    }
  });
}

module.exports = { createHotelAvailabilityService };
