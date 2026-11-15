"use strict";

const RESERVATION_EVENTS = new Set([
  "reservation.created",
  "reservation.updated",
  "reservation.cancelled",
  "reservation.checked_in",
  "reservation.checked_out"
]);
const RESERVATION_STATUSES = new Set([
  "pending", "confirmed", "cancelled", "checked_in", "checked_out", "no_show"
]);
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ATTRIBUTION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function requiredString(value, field, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(field + " is required and must be a string of at most " + max + " characters.");
  }
  return value.trim();
}

function isoDate(value, field) {
  if (typeof value !== "string" || !DATE.test(value)) {
    throw new Error(field + " must be a calendar date in YYYY-MM-DD format.");
  }
  const d = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new Error(field + " must be a valid calendar date.");
  }
  return value;
}

function isoTimestamp(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) {
    throw new Error(field + " must be an ISO-8601 UTC timestamp.");
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(field + " must be a valid timestamp.");
  const canonical = new Date(time).toISOString();
  const supplied = value.includes(".")
    ? value.replace(/(\.\d{1,2})Z$/, match => match.slice(0, -1).padEnd(4, "0") + "Z")
    : value.replace("Z", ".000Z");
  if (canonical !== supplied) throw new Error(field + " must be a real UTC calendar timestamp.");
  return canonical;
}

function normalizeReservationEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("PMS reservation event must be an object.");
  }
  const eventType = requiredString(input.eventType, "eventType", 48);
  if (!RESERVATION_EVENTS.has(eventType)) throw new Error("Unsupported PMS reservation event type.");
  const status = requiredString(input.status, "status", 24);
  if (!RESERVATION_STATUSES.has(status)) throw new Error("Unsupported reservation status.");
  const arrivalDate = isoDate(input.arrivalDate, "arrivalDate");
  const departureDate = isoDate(input.departureDate, "departureDate");
  if (departureDate <= arrivalDate) throw new Error("departureDate must be after arrivalDate.");
  const event = {
    schemaVersion: 1,
    eventId: requiredString(input.eventId, "eventId", 200),
    eventType,
    occurredAt: isoTimestamp(input.occurredAt, "occurredAt"),
    reservationId: requiredString(input.reservationId, "reservationId", 200),
    status,
    arrivalDate,
    departureDate,
    roomTypeCode: input.roomTypeCode == null ? null : requiredString(input.roomTypeCode, "roomTypeCode", 80),
    currency: input.currency == null ? null : requiredString(input.currency, "currency", 3).toUpperCase()
  };
  if (event.currency && !CURRENCY.test(event.currency)) throw new Error("currency must be a three-letter ISO currency code.");
  if (input.attributionToken != null) {
    const token = requiredString(input.attributionToken, "attributionToken", 43);
    if (!ATTRIBUTION_TOKEN.test(token)) throw new Error("attributionToken must be a 256-bit base64url Veyra reference.");
    event.attributionToken = token;
  }
  if (input.totalAmountMinor != null) {
    if (!Number.isSafeInteger(input.totalAmountMinor) || input.totalAmountMinor < 0) {
      throw new Error("totalAmountMinor must be a non-negative safe integer.");
    }
    if (!event.currency) throw new Error("currency is required when totalAmountMinor is supplied.");
    event.totalAmountMinor = input.totalAmountMinor;
  } else {
    event.totalAmountMinor = null;
  }
  // Deliberately discard guest names, emails, phone numbers, payment data and free-text notes.
  return Object.freeze(event);
}

function normalizeAvailabilitySnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("PMS availability snapshot must be an object.");
  }
  const observedAt = isoTimestamp(input.observedAt, "observedAt");
  const validUntil = isoTimestamp(input.validUntil, "validUntil");
  if (Date.parse(validUntil) <= Date.parse(observedAt)) {
    throw new Error("validUntil must be later than observedAt.");
  }
  if (Date.parse(validUntil) - Date.parse(observedAt) > 15 * 60 * 1000) {
    throw new Error("Availability snapshots cannot be considered valid for more than 15 minutes.");
  }
  const arrivalDate = isoDate(input.arrivalDate, "arrivalDate");
  const departureDate = isoDate(input.departureDate, "departureDate");
  if (departureDate <= arrivalDate) throw new Error("departureDate must be after arrivalDate.");
  if (!Number.isSafeInteger(input.roomsAvailable) || input.roomsAvailable < 0) {
    throw new Error("roomsAvailable must be a non-negative safe integer.");
  }
  return Object.freeze({
    schemaVersion: 1,
    propertyReference: requiredString(input.propertyReference, "propertyReference", 160),
    roomTypeCode: requiredString(input.roomTypeCode, "roomTypeCode", 80),
    arrivalDate,
    departureDate,
    roomsAvailable: input.roomsAvailable,
    observedAt,
    validUntil,
    sourceEventId: requiredString(input.sourceEventId, "sourceEventId", 200)
  });
}

function createPmsAdapter({ provider, mapReservationEvent, mapAvailabilitySnapshot }) {
  const providerName = requiredString(provider, "provider", 80);
  if (typeof mapReservationEvent !== "function" || typeof mapAvailabilitySnapshot !== "function") {
    throw new Error("A PMS adapter must implement reservation and availability mapping.");
  }
  return Object.freeze({
    provider: providerName,
    reservationEvent(payload) {
      const event = normalizeReservationEvent(mapReservationEvent(payload));
      return Object.freeze({ ...event, provider: providerName });
    },
    availabilitySnapshot(payload) {
      return normalizeAvailabilitySnapshot(mapAvailabilitySnapshot(payload));
    }
  });
}

module.exports = {
  RESERVATION_EVENTS,
  normalizeReservationEvent,
  normalizeAvailabilitySnapshot,
  createPmsAdapter
};
