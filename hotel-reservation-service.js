"use strict";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_-]{20,100}$/;
const PHONE = /^\+[1-9]\d{7,14}$/;

function date(value, field) {
  if (typeof value !== "string" || !DATE.test(value)) throw new Error(field + " must use YYYY-MM-DD.");
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(field + " must be a real calendar date.");
  }
  return value;
}

function text(value, field, max = 160) {
  if (typeof value !== "string") throw new Error(field + " is required.");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(field + " is invalid.");
  }
  return normalized;
}

function timestamp(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(field + " must be a valid timestamp.");
  }
  return Date.parse(value);
}

function validateRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Reservation request is required.");
  if (input.consentToShareDetails !== true) throw new Error("Guest consent is required before sharing contact details.");
  const guestName = text(input.guestName, "guestName", 160);
  if (guestName.split(" ").length < 2) throw new Error("A full guest name is required.");
  const guestPhone = text(input.guestPhone, "guestPhone", 16);
  if (!PHONE.test(guestPhone)) throw new Error("guestPhone must use international E.164 format.");
  const arrivalDate = date(input.arrivalDate, "arrivalDate");
  const departureDate = date(input.departureDate, "departureDate");
  if (departureDate <= arrivalDate) throw new Error("departureDate must be after arrivalDate.");
  if (!Number.isInteger(input.adults) || input.adults < 1 || input.adults > 20) throw new Error("adults must be from 1 to 20.");
  if (input.children != null && (!Number.isInteger(input.children) || input.children < 0 || input.children > 20)) {
    throw new Error("children must be from 0 to 20.");
  }
  const roomTypeCode = text(input.roomTypeCode, "roomTypeCode", 80);
  const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 100);
  if (!IDEMPOTENCY.test(idempotencyKey)) throw new Error("A valid idempotencyKey is required.");
  return Object.freeze({
    guest: Object.freeze({ fullName: guestName, phone: guestPhone }),
    arrivalDate,
    departureDate,
    adults: input.adults,
    children: input.children || 0,
    roomTypeCode,
    idempotencyKey
  });
}

/**
 * Provider-neutral orchestration. The hotel-specific adapter must be supplied
 * by authorised hotel IT and must enforce tenant isolation and provider-side
 * idempotency. This module never stores credentials or implements a PMS API.
 */
function createHotelReservationService({ provider, organizationId, now = () => new Date() } = {}) {
  if (!provider || typeof provider !== "object") throw new Error("An authorised hotel reservation provider is required.");
  if (typeof organizationId !== "string" || !organizationId.trim()) throw new Error("organizationId is required.");
  if (provider.organizationId !== organizationId) throw new Error("Provider tenant does not match the hotel workspace.");
  if (provider.supportsIdempotency !== true) throw new Error("Provider-side idempotency support is required.");
  if (typeof provider.checkAvailability !== "function" || typeof provider.createReservation !== "function") {
    throw new Error("Provider must implement checkAvailability and createReservation.");
  }

  return Object.freeze({
    async book(input) {
      const request = validateRequest(input);
      let inventory;
      try {
        inventory = await provider.checkAvailability({
          organizationId,
          arrivalDate: request.arrivalDate,
          departureDate: request.departureDate,
          roomTypeCode: request.roomTypeCode,
          adults: request.adults,
          children: request.children
        });
      } catch {
        return Object.freeze({ status: "staff_handoff", confirmed: false, reason: "availability_check_failed" });
      }

      if (!inventory || inventory.organizationId !== organizationId ||
          inventory.arrivalDate !== request.arrivalDate ||
          inventory.departureDate !== request.departureDate ||
          inventory.roomTypeCode !== request.roomTypeCode ||
          !Number.isSafeInteger(inventory.roomsAvailable) || inventory.roomsAvailable < 0) {
        return Object.freeze({ status: "staff_handoff", confirmed: false, reason: "unverified_inventory" });
      }
      const checkedAt = now();
      if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) throw new Error("Clock returned an invalid time.");
      let observedAt;
      let validUntil;
      try {
        observedAt = timestamp(inventory.observedAt, "observedAt");
        validUntil = timestamp(inventory.validUntil, "validUntil");
      } catch {
        return Object.freeze({ status: "staff_handoff", confirmed: false, reason: "unverified_inventory" });
      }
      if (observedAt > checkedAt.getTime() || validUntil <= checkedAt.getTime() ||
          validUntil <= observedAt || validUntil - observedAt > 5 * 60 * 1000 ||
          inventory.roomsAvailable < 1) {
        return Object.freeze({ status: "staff_handoff", confirmed: false, reason: "room_not_available_or_inventory_stale" });
      }

      let result;
      try {
        result = await provider.createReservation({
          organizationId,
          idempotencyKey: request.idempotencyKey,
          guest: request.guest,
          arrivalDate: request.arrivalDate,
          departureDate: request.departureDate,
          adults: request.adults,
          children: request.children,
          roomTypeCode: request.roomTypeCode
        });
      } catch {
        return Object.freeze({ status: "staff_handoff", confirmed: false, reason: "reservation_write_failed" });
      }

      if (!result || result.organizationId !== organizationId) {
        return Object.freeze({ status: "staff_handoff", confirmed: false, reason: "unverified_provider_result" });
      }
      if (result.status !== "confirmed" || typeof result.bookingReference !== "string" || !result.bookingReference.trim()) {
        return Object.freeze({ status: "request_pending", confirmed: false, reason: "provider_has_not_confirmed" });
      }
      return Object.freeze({
        status: "confirmed",
        confirmed: true,
        bookingReference: text(result.bookingReference, "bookingReference", 120),
        arrivalDate: request.arrivalDate,
        departureDate: request.departureDate,
        roomTypeCode: request.roomTypeCode
      });
    }
  });
}

module.exports = { createHotelReservationService, validateRequest };
