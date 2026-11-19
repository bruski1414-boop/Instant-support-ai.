"use strict";

const crypto = require("node:crypto");
const { validateAddReservationsPayload } = require("./mews-connector-client");

function requiredText(value, field, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      [...value].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })) {
    throw new Error(field + " is invalid.");
  }
  return value.trim();
}

function stableRequestHash(input) {
  const canonical = JSON.stringify({
    organizationId: input.organizationId,
    guest: { fullName: input.guest.fullName, phone: input.guest.phone },
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    adults: input.adults,
    children: input.children,
    roomTypeCode: input.roomTypeCode
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Demo-only Mews reservation adapter.
 *
 * Mews reservations/add has no native idempotency-key field. This adapter
 * therefore requires a durable, atomic idempotency store supplied by the
 * hotel integration. Ambiguous writes are marked uncertain and are never
 * retried automatically; hotel staff must reconcile them in Mews.
 *
 * resolveReservation must map an already-authorised guest profile to a Mews
 * CustomerId and return the property's exact UTC boundaries and RateId.
 */
function createMewsReservationWriter({
  client,
  tenantId,
  serviceId,
  resourceCategoryId,
  availabilityAdapter,
  resolveReservation,
  idempotencyStore
} = {}) {
  const organizationId = requiredText(tenantId, "tenantId", 128);
  const safeServiceId = requiredText(serviceId, "serviceId", 128);
  const safeCategoryId = requiredText(resourceCategoryId, "resourceCategoryId", 128);

  if (!client || client.providerId !== "mews" || client.tenantId !== organizationId ||
      client.environment !== "demo" || client.writeEnabled !== true ||
      typeof client.addReservations !== "function") {
    throw new Error("An explicitly enabled Mews demo client is required.");
  }
  if (!availabilityAdapter || availabilityAdapter.organizationId !== organizationId ||
      typeof availabilityAdapter.checkAvailability !== "function") {
    throw new Error("A same-tenant Mews availability adapter is required.");
  }
  if (typeof resolveReservation !== "function") {
    throw new Error("A hotel-approved guest and rate resolver is required.");
  }
  if (!idempotencyStore || idempotencyStore.durable !== true ||
      typeof idempotencyStore.claim !== "function" ||
      typeof idempotencyStore.complete !== "function" ||
      typeof idempotencyStore.markUncertain !== "function" ||
      typeof idempotencyStore.release !== "function") {
    throw new Error("A durable atomic idempotency store with safe preflight release is required before enabling reservation writes.");
  }

  async function createReservation(input = {}) {
    if (!input || input.organizationId !== organizationId) {
      throw new Error("Reservation tenant does not match the configured Mews property.");
    }
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 100);
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(idempotencyKey)) {
      throw new Error("A valid reservation idempotency key is required.");
    }
    const arrivalDate = requiredText(input.arrivalDate, "arrivalDate", 10);
    const departureDate = requiredText(input.departureDate, "departureDate", 10);
    const validDate = value => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) &&
      Number.isFinite(Date.parse(value + "T00:00:00.000Z")) &&
      new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) === value;
    if (!validDate(arrivalDate) || !validDate(departureDate) || departureDate <= arrivalDate) {
      throw new Error("A valid arrival and departure date range is required.");
    }
    if (!Number.isInteger(input.adults) || input.adults < 1 || input.adults > 20 ||
        !Number.isInteger(input.children) || input.children < 0 || input.children > 20) {
      throw new Error("Valid adult and child guest counts are required.");
    }
    const roomTypeCode = requiredText(input.roomTypeCode, "roomTypeCode", 80);
    if (!input.guest || typeof input.guest !== "object" || Array.isArray(input.guest)) {
      throw new Error("Guest details are required.");
    }
    const guest = {
      fullName: requiredText(input.guest.fullName, "guest.fullName", 160),
      phone: requiredText(input.guest.phone, "guest.phone", 16)
    };
    if (guest.fullName.split(" ").filter(Boolean).length < 2 ||
        !guest.phone.startsWith("+") || !/^[0-9]{8,15}$/.test(guest.phone.slice(1))) {
      throw new Error("A full guest name and international phone number are required.");
    }
    const hash = stableRequestHash({ ...input, arrivalDate, departureDate, roomTypeCode, guest });
    const claim = await idempotencyStore.claim({ organizationId, idempotencyKey, requestHash: hash });
    if (!claim || typeof claim !== "object") throw new Error("Idempotency store returned an invalid claim.");
    if (claim.status === "completed" && claim.result) {
      return { ...claim.result, organizationId };
    }
    if (claim.status !== "acquired") {
      throw new Error("This reservation request is already running or requires staff reconciliation.");
    }

    let payload;
    try {
      const availability = await availabilityAdapter.checkAvailability({
        arrivalDate,
        departureDate,
        roomTypeCode
      });
      const observedAt = availability && Date.parse(availability.observedAt);
      const validUntil = availability && Date.parse(availability.validUntil);
      const now = Date.now();
      if (!availability || availability.organizationId !== organizationId ||
          availability.arrivalDate !== input.arrivalDate ||
          availability.departureDate !== input.departureDate ||
          availability.roomTypeCode !== input.roomTypeCode ||
          !Number.isSafeInteger(availability.roomsAvailable) || availability.roomsAvailable < 1 ||
          !Number.isFinite(observedAt) || !Number.isFinite(validUntil) ||
          observedAt > now || validUntil <= now || validUntil <= observedAt ||
          now - observedAt > 5 * 60 * 1000 || validUntil - observedAt > 15 * 60 * 1000) {
        throw new Error("Fresh, matching live room availability for this hotel and stay is required before booking.");
      }

      const mapping = await resolveReservation({
        organizationId,
        guest: input.guest,
        arrivalDate: input.arrivalDate,
        departureDate: input.departureDate,
        adults: input.adults,
        children: input.children,
        roomTypeCode: input.roomTypeCode
      });
      if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
        throw new Error("Hotel guest and rate mapping is incomplete.");
      }
      if (mapping.roomTypeCode !== roomTypeCode ||
          mapping.arrivalDate !== arrivalDate ||
          mapping.departureDate !== departureDate ||
          (mapping.serviceId && mapping.serviceId !== safeServiceId) ||
          (mapping.resourceCategoryId && mapping.resourceCategoryId !== safeCategoryId)) {
        throw new Error("Hotel reservation mapping does not match the approved service, room category or stay.");
      }

      payload = validateAddReservationsPayload({
        ServiceId: safeServiceId,
        Reservations: [{
          CustomerId: requiredText(mapping.customerId, "customerId", 128),
          RequestedCategoryId: safeCategoryId,
          RateId: requiredText(mapping.rateId, "rateId", 128),
          StartUtc: mapping.startUtc,
          EndUtc: mapping.endUtc,
          PersonCounts: { AdultCount: input.adults, ChildCount: input.children }
        }]
      });
    } catch (error) {
      await idempotencyStore.release({ organizationId, idempotencyKey, requestHash: hash });
      throw error;
    }

    let response;
    try {
      response = await client.addReservations(payload);
    } catch {
      await idempotencyStore.markUncertain({
        organizationId, idempotencyKey, requestHash: hash, reason: "provider_write_outcome_unknown"
      });
      throw new Error("Mews reservation write outcome is uncertain; staff reconciliation is required before retrying.");
    }

    const added = response && Array.isArray(response.Reservations) && response.Reservations.length === 1
      ? response.Reservations[0] : null;
    const reservation = added && added.Reservation;
    const bookingReference = reservation && typeof reservation.Number === "string"
      ? reservation.Number.trim() : "";
    const reservationId = reservation && typeof reservation.Id === "string"
      ? reservation.Id.trim() : "";
    const state = reservation && typeof reservation.State === "string"
      ? reservation.State.trim().toLowerCase() : "";

    if (!reservationId || !bookingReference || state !== "confirmed") {
      await idempotencyStore.markUncertain({
        organizationId, idempotencyKey, requestHash: hash, reason: "provider_response_unverified"
      });
      throw new Error("Mews returned no verifiable confirmed reservation; staff reconciliation is required.");
    }

    const result = {
      organizationId,
      status: "confirmed",
      confirmed: true,
      bookingReference,
      providerReservationId: reservationId
    };
    try {
      await idempotencyStore.complete({ organizationId, idempotencyKey, requestHash: hash, result });
    } catch {
      await idempotencyStore.markUncertain({
        organizationId, idempotencyKey, requestHash: hash, reason: "idempotency_commit_failed_after_provider_write"
      });
      throw new Error("Mews may have confirmed the reservation but the idempotency record failed; staff reconciliation is required.");
    }
    return result;
  }

  return Object.freeze({
    providerId: "mews",
    tenantId: organizationId,
    organizationId,
    supportsIdempotency: true,
    capabilities: Object.freeze(["availability", "reservations"]),
    checkAvailability: input => availabilityAdapter.checkAvailability(input),
    availability: input => availabilityAdapter.checkAvailability(input),
    createReservation,
    reservations: createReservation
  });
}

module.exports = { createMewsReservationWriter, stableRequestHash };
