"use strict";

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const E164 = /^\+[1-9]\d{7,14}$/;

function requiredText(value, field, maxLength) {
  if (typeof value !== "string") throw new Error(field + " is required.");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(field + " is invalid.");
  }
  return normalized;
}

function normalizeGuestPhone(value) {
  const phone = requiredText(value, "guestPhone", 16);
  if (!E164.test(phone)) throw new Error("guestPhone must use international E.164 format, for example +441234567890.");
  return phone;
}

function normalizeRequestedTime(value) {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("requestedTime must be an ISO-8601 date-time with a timezone.");
  }
  return new Date(value).toISOString();
}

/**
 * Validates a guest request for a hotel-arranged buggy journey.
 * This creates a REQUEST payload only. It does not reserve a vehicle, dispatch
 * a driver, write to a PMS, or tell the guest that the journey is confirmed.
 */
function buildBuggyServiceRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A buggy service request is required.");
  }
  if (input.consentToShareDetails !== true) {
    throw new Error("Guest consent to share contact details with the hotel transport team is required.");
  }
  const fullName = requiredText(input.guestFullName, "guestFullName", 160);
  if (fullName.split(" ").length < 2) throw new Error("guestFullName must include the guest's full name.");
  const guestPhone = normalizeGuestPhone(input.guestPhone);
  if (!Number.isInteger(input.guestCount) || input.guestCount < 1 || input.guestCount > 20) {
    throw new Error("guestCount must be an integer between 1 and 20.");
  }
  const pickupLocation = requiredText(input.pickupLocation, "pickupLocation", 160);
  const dropoffLocation = requiredText(input.dropoffLocation, "dropoffLocation", 160);
  const requestedTime = normalizeRequestedTime(input.requestedTime);
  const guestNote = input.guestNote == null ? "" : requiredText(input.guestNote, "guestNote", 500);

  return Object.freeze({
    schemaVersion: 1,
    serviceType: "buggy_transport",
    status: "request_pending",
    guest: Object.freeze({ fullName, phoneE164: guestPhone }),
    guestCount: input.guestCount,
    pickupLocation,
    dropoffLocation,
    requestedTime,
    guestNote,
    consentToShareDetails: true,
    confirmationRequired: true,
    providerWritePerformed: false
  });
}

module.exports = { buildBuggyServiceRequest, normalizeGuestPhone, normalizeRequestedTime };
