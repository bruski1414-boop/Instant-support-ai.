"use strict";

const CURRENCIES = /^[A-Z]{3}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{12,100}$/;

class BookingWorkflowError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "BookingWorkflowError";
    this.code = code;
    this.status = status;
  }
}

function normalizeGuestDetails(input = {}) {
  const name = typeof input.name === "string" ? input.name.trim().replace(/\\s+/g, " ") : "";
  const phone = typeof input.phone === "string" ? input.phone.trim().replace(/[\\s().-]/g, "") : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (name.length < 2 || name.length > 120 || /[<>\\u0000-\\u001f]/.test(name)) {
    throw new BookingWorkflowError("INVALID_GUEST_NAME", "Enter the guest's full name.");
  }
  if (!/^\\+[1-9]\\d{7,14}$/.test(phone)) {
    throw new BookingWorkflowError("INVALID_GUEST_PHONE", "Enter a phone number in international format.");
  }
  if (email && (email.length > 254 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email))) {
    throw new BookingWorkflowError("INVALID_GUEST_EMAIL", "Enter a valid email address or leave it blank.");
  }
  return { name, phone, email: email || null };
}

function calculateDeposit(totalAmountMinor, currency, percentage = 50) {
  if (!Number.isSafeInteger(totalAmountMinor) || totalAmountMinor <= 0 ||
      !CURRENCIES.test(String(currency || "")) ||
      !Number.isInteger(percentage) || percentage !== 50) {
    throw new BookingWorkflowError("INVALID_DEPOSIT_QUOTE", "A valid total, currency and 50% deposit are required.");
  }
  return {
    totalAmountMinor,
    depositAmountMinor: Math.ceil(totalAmountMinor * percentage / 100),
    balanceAmountMinor: Math.floor(totalAmountMinor / 2),
    currency,
    depositPercentage: percentage,
  };
}

function createBookingIntent(input = {}) {
  if (input.guestConfirmed !== true) {
    throw new BookingWorkflowError("GUEST_CONFIRMATION_REQUIRED", "The guest must explicitly confirm the exact booking details.");
  }
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new BookingWorkflowError("INVALID_IDEMPOTENCY_KEY", "A valid booking idempotency key is required.");
  }
  const quote = input.quote;
  if (!quote || quote.availabilityVerified !== true ||
      !(quote.expiresAt instanceof Date) || !Number.isFinite(quote.expiresAt.getTime()) ||
      quote.expiresAt.getTime() <= Date.now()) {
    throw new BookingWorkflowError("QUOTE_NOT_VERIFIED", "A current, verified availability and price quote are required.", 409);
  }
  const guest = normalizeGuestDetails(input.guest);
  const payment = calculateDeposit(quote.totalAmountMinor, quote.currency);
  const bookingDetails = {
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
    roomTypeId: quote.roomTypeId,
    roomTypeName: quote.roomTypeName,
    guestCount: quote.guestCount,
  };
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(bookingDetails.checkIn || "") ||
      !/^\\d{4}-\\d{2}-\\d{2}$/.test(bookingDetails.checkOut || "") ||
      !bookingDetails.roomTypeId || bookingDetails.roomTypeId.length > 120 ||
      !bookingDetails.roomTypeName || bookingDetails.roomTypeName.length > 160 ||
      !Number.isInteger(bookingDetails.guestCount) || bookingDetails.guestCount < 1 || bookingDetails.guestCount > 20) {
    throw new BookingWorkflowError("INVALID_BOOKING_DETAILS", "The quoted room and stay details are incomplete.");
  }
  return Object.freeze({
    idempotencyKey,
    status: "awaiting_payment",
    guest,
    booking: bookingDetails,
    quoteExpiresAt: quote.expiresAt.toISOString(),
    ...payment,
    paymentProviderReference: null,
    reservationId: null,
  });
}

function recordVerifiedDeposit(state, event = {}) {
  if (!state || state.status !== "awaiting_payment") {
    throw new BookingWorkflowError("INVALID_BOOKING_STATE", "This booking is not awaiting a deposit.", 409);
  }
  if (event.signatureVerified !== true || event.paymentStatus !== "succeeded") {
    throw new BookingWorkflowError("PAYMENT_NOT_VERIFIED", "Only a verified successful payment event can satisfy the deposit.", 409);
  }
  if (!Number.isSafeInteger(event.amountMinor) || event.amountMinor !== state.depositAmountMinor ||
      event.currency !== state.currency || typeof event.providerReference !== "string" ||
      !event.providerReference.trim() || event.providerReference.length > 200) {
    throw new BookingWorkflowError("PAYMENT_MISMATCH", "The verified payment does not match the required deposit.", 409);
  }
  return Object.freeze({
    ...state,
    status: "deposit_paid",
    paymentProviderReference: event.providerReference.trim(),
  });
}

function recordConfirmedReservation(state, providerResult = {}) {
  if (!state || state.status !== "deposit_paid") {
    throw new BookingWorkflowError("DEPOSIT_REQUIRED", "The deposit must be verified before reservation confirmation.", 409);
  }
  const reservationId = typeof providerResult.reservationId === "string" ? providerResult.reservationId.trim() : "";
  if (providerResult.providerConfirmed !== true || !reservationId || reservationId.length > 160) {
    throw new BookingWorkflowError("RESERVATION_NOT_CONFIRMED", "The hotel booking system has not confirmed this reservation.", 409);
  }
  return Object.freeze({ ...state, status: "confirmed", reservationId });
}

module.exports = {
  BookingWorkflowError,
  normalizeGuestDetails,
  calculateDeposit,
  createBookingIntent,
  recordVerifiedDeposit,
  recordConfirmedReservation,
};
