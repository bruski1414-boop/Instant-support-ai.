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
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  const phone = typeof input.phone === "string" ? input.phone.trim().replace(/[\s().-]/g, "") : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (name.length < 2 || name.length > 120 || /[<>\u0000-\u001f]/.test(name)) {
    throw new BookingWorkflowError("INVALID_GUEST_NAME", "Enter the guest's full name.");
  }
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new BookingWorkflowError("INVALID_GUEST_PHONE", "Enter a phone number in international format.");
  }
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new BookingWorkflowError("INVALID_GUEST_EMAIL", "Enter a valid email address or leave it blank.");
  }
  return { name, phone, email: email || null };
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function calculateDeposit(totalAmountMinor, currency, percentage = 50) {
  if (!Number.isSafeInteger(totalAmountMinor) || totalAmountMinor <= 0 ||
      !CURRENCIES.test(String(currency || "")) ||
      !Number.isInteger(percentage) || percentage !== 50) {
    throw new BookingWorkflowError("INVALID_DEPOSIT_QUOTE", "A valid total, currency and 50% deposit are required.");
  }
  const depositAmountMinor = Math.ceil(totalAmountMinor / 2);
  return {
    totalAmountMinor,
    depositAmountMinor,
    balanceAmountMinor: totalAmountMinor - depositAmountMinor,
    currency,
    depositPercentage: percentage,
  };
}

function createBookingIntent(input = {}, options = {}) {
  if (input.guestConfirmed !== true) {
    throw new BookingWorkflowError("GUEST_CONFIRMATION_REQUIRED", "The guest must explicitly confirm the exact booking details.");
  }
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new BookingWorkflowError("INVALID_IDEMPOTENCY_KEY", "A valid booking idempotency key is required.");
  }
  const quote = input.quote;
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  if (!quote || quote.availabilityVerified !== true ||
      !(quote.expiresAt instanceof Date) || !Number.isFinite(quote.expiresAt.getTime()) ||
      quote.expiresAt.getTime() <= now) {
    throw new BookingWorkflowError("QUOTE_NOT_VERIFIED", "A current, verified availability and price quote are required.", 409);
  }
  const guest = normalizeGuestDetails(input.guest);
  const payment = calculateDeposit(quote.totalAmountMinor, quote.currency);
  const booking = {
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
    roomTypeId: typeof quote.roomTypeId === "string" ? quote.roomTypeId.trim() : "",
    roomTypeName: typeof quote.roomTypeName === "string" ? quote.roomTypeName.trim() : "",
    guestCount: quote.guestCount,
  };
  if (!validIsoDate(booking.checkIn) || !validIsoDate(booking.checkOut) ||
      Date.parse(booking.checkOut + "T00:00:00Z") <= Date.parse(booking.checkIn + "T00:00:00Z") ||
      !booking.roomTypeId || booking.roomTypeId.length > 120 ||
      !booking.roomTypeName || booking.roomTypeName.length > 160 ||
      !Number.isInteger(booking.guestCount) || booking.guestCount < 1 || booking.guestCount > 20) {
    throw new BookingWorkflowError("INVALID_BOOKING_DETAILS", "The quoted room and stay details are incomplete.");
  }
  return Object.freeze({
    idempotencyKey,
    status: "awaiting_payment",
    guest,
    booking,
    quoteExpiresAt: quote.expiresAt.toISOString(),
    ...payment,
    paymentProviderReference: null,
    reservationId: null,
  });
}

function recordVerifiedDeposit(state, event = {}) {
  if (!state || typeof state !== "object") {
    throw new BookingWorkflowError("INVALID_BOOKING_STATE", "Booking state is missing.", 409);
  }
  if (state.status === "deposit_paid" || state.status === "confirmed") {
    if (event.signatureVerified === true && event.paymentStatus === "succeeded" &&
        event.providerReference === state.paymentProviderReference &&
        event.amountMinor === state.depositAmountMinor && event.currency === state.currency) return state;
    throw new BookingWorkflowError("PAYMENT_ALREADY_RECORDED", "A different payment cannot replace the recorded deposit.", 409);
  }
  if (state.status !== "awaiting_payment") {
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
  if (!state || typeof state !== "object") {
    throw new BookingWorkflowError("INVALID_BOOKING_STATE", "Booking state is missing.", 409);
  }
  const reservationId = typeof providerResult.reservationId === "string" ? providerResult.reservationId.trim() : "";
  if (state.status === "confirmed" && providerResult.providerConfirmed === true &&
      reservationId && reservationId === state.reservationId) return state;
  if (state.status !== "deposit_paid") {
    throw new BookingWorkflowError("DEPOSIT_REQUIRED", "The deposit must be verified before reservation confirmation.", 409);
  }
  if (providerResult.providerConfirmed !== true || !reservationId || reservationId.length > 160) {
    throw new BookingWorkflowError("RESERVATION_NOT_CONFIRMED", "The hotel booking system has not confirmed this reservation.", 409);
  }
  return Object.freeze({ ...state, status: "confirmed", reservationId });
}

module.exports = {
  BookingWorkflowError,
  normalizeGuestDetails,
  validIsoDate,
  calculateDeposit,
  createBookingIntent,
  recordVerifiedDeposit,
  recordConfirmedReservation,
};
