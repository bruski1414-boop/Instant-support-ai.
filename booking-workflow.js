"use strict";

const { PmsIntegrationError, validateDateRange } = require("./pms-integration");

const BOOKING_STATES = Object.freeze([
  "draft", "awaiting_payment", "payment_pending", "payment_verified",
  "booking_pending", "confirmed", "payment_failed", "booking_failed", "cancelled",
]);

function normalizeGuestDetails(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PmsIntegrationError("INVALID_GUEST_DETAILS", "Guest details are required.");
  }
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (name.length < 2 || name.length > 120 || /[<>\u0000-\u001f]/.test(name)) {
    throw new PmsIntegrationError("INVALID_GUEST_NAME", "Enter a valid guest name.");
  }
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new PmsIntegrationError("INVALID_GUEST_PHONE", "Enter a phone number in international format, including country code.");
  }
  if (email && (email.length > 254 || !/^[-.+\w]+@[-.\w]+\.[A-Za-z]{2,}$/.test(email))) {
    throw new PmsIntegrationError("INVALID_GUEST_EMAIL", "Enter a valid email address or leave it blank.");
  }
  return { name, phone, email: email || null };
}

function calculateDeposit(totalAmountMinor, depositPercent = 50) {
  if (!Number.isSafeInteger(totalAmountMinor) || totalAmountMinor <= 0 ||
      !Number.isInteger(depositPercent) || depositPercent !== 50) {
    throw new PmsIntegrationError("INVALID_DEPOSIT_AMOUNT", "A positive quoted total and the configured 50% deposit are required.");
  }
  const depositAmountMinor = Math.ceil(totalAmountMinor * depositPercent / 100);
  return {
    totalAmountMinor, depositPercent, depositAmountMinor,
    balanceAmountMinor: totalAmountMinor - depositAmountMinor,
  };
}

function buildBookingIntent(input = {}) {
  const dates = validateDateRange(input);
  const guest = normalizeGuestDetails(input.guest);
  const roomTypeId = typeof input.roomTypeId === "string" ? input.roomTypeId.trim() : "";
  const guestCount = input.guestCount;
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  const totalAmountMinor = input.totalAmountMinor;
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!roomTypeId || roomTypeId.length > 120 ||
      !Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20 ||
      !/^[A-Z]{3}$/.test(currency) ||
      !/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) {
    throw new PmsIntegrationError("INVALID_BOOKING_INTENT", "A valid room, guest count, currency and unique request key are required.");
  }
  const verifiedAt = typeof input.availabilityVerifiedAt === "string" ? Date.parse(input.availabilityVerifiedAt) : NaN;
  if (input.availabilityVerified !== true || !Number.isFinite(verifiedAt) ||
      Date.now() - verifiedAt > 5 * 60 * 1000 || verifiedAt > Date.now()) {
    throw new PmsIntegrationError("AVAILABILITY_NOT_VERIFIED", "Live room availability must be rechecked immediately before taking a deposit.", 409);
  }
  const amounts = calculateDeposit(totalAmountMinor, 50);
  return {
    ...dates, guest, roomTypeId, guestCount, currency, ...amounts,
    idempotencyKey, state: "awaiting_payment", createdAt: new Date().toISOString(),
  };
}

function assertBookingTransition(currentState, nextState, evidence = {}) {
  const allowed = {
    draft: ["awaiting_payment", "cancelled"],
    awaiting_payment: ["payment_pending", "cancelled"],
    payment_pending: ["payment_verified", "payment_failed", "cancelled"],
    payment_verified: ["booking_pending", "cancelled"],
    booking_pending: ["confirmed", "booking_failed"],
    payment_failed: ["cancelled"],
    booking_failed: ["cancelled"],
    confirmed: ["cancelled"],
    cancelled: [],
  };
  if (!BOOKING_STATES.includes(currentState) || !allowed[currentState]?.includes(nextState)) {
    throw new PmsIntegrationError("INVALID_BOOKING_TRANSITION", "This booking status change is not permitted.", 409);
  }
  if (nextState === "payment_verified" && evidence.paymentProviderVerified !== true) {
    throw new PmsIntegrationError("PAYMENT_NOT_VERIFIED", "Only a verified payment-provider event can confirm a deposit.", 409);
  }
  if (nextState === "confirmed" && (evidence.pmsConfirmed !== true ||
      typeof evidence.pmsBookingId !== "string" || !evidence.pmsBookingId.trim())) {
    throw new PmsIntegrationError("PMS_BOOKING_NOT_CONFIRMED", "The booking can only be confirmed after the PMS returns a booking reference.", 409);
  }
  return nextState;
}

module.exports = {
  BOOKING_STATES, normalizeGuestDetails, calculateDeposit, buildBookingIntent, assertBookingTransition,
};
