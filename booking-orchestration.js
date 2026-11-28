"use strict";

const { PmsIntegrationError } = require("./pms-integration");

function validateVerifiedDeposit(booking, paymentEvidence) {
  if (!booking || typeof booking !== "object" || Array.isArray(booking) ||
      booking.state !== "payment_verified") {
    throw new PmsIntegrationError("PAYMENT_NOT_VERIFIED", "A verified deposit is required before creating a hotel reservation.", 409);
  }
  if (!paymentEvidence || typeof paymentEvidence !== "object" ||
      paymentEvidence.verified !== true || paymentEvidence.status !== "succeeded" ||
      typeof paymentEvidence.providerPaymentId !== "string" || !paymentEvidence.providerPaymentId.trim() ||
      paymentEvidence.amountMinor !== booking.depositAmountMinor ||
      typeof paymentEvidence.currency !== "string" ||
      paymentEvidence.currency.toUpperCase() !== booking.currency) {
    throw new PmsIntegrationError("DEPOSIT_EVIDENCE_MISMATCH", "The payment provider has not verified the exact deposit amount and currency for this booking.", 409);
  }
  if (!Number.isSafeInteger(booking.totalAmountMinor) || booking.totalAmountMinor <= 0 ||
      !Number.isSafeInteger(booking.depositAmountMinor) ||
      booking.depositAmountMinor !== Math.ceil(booking.totalAmountMinor * 0.5) ||
      !/^[A-Z]{3}$/.test(booking.currency || "") ||
      typeof booking.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_-]{12,100}$/.test(booking.idempotencyKey)) {
    throw new PmsIntegrationError("INVALID_BOOKING_RECORD", "The stored booking record is incomplete.", 409);
  }
}

function buildPmsBookingRequest(booking) {
  return {
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    roomTypeId: booking.roomTypeId,
    guestCount: booking.guestCount,
    idempotencyKey: booking.idempotencyKey,
  };
}

/**
 * Calls the hotel's PMS only after the exact 50% deposit has been verified.
 * The adapter must pass idempotencyKey through to the provider's idempotency
 * mechanism. A timeout is treated as an unknown outcome, never as permission
 * to submit a second booking with a new key.
 */
async function createReservationAfterVerifiedDeposit({
  booking,
  paymentEvidence,
  pms,
  provider,
  context = {},
}) {
  validateVerifiedDeposit(booking, paymentEvidence);
  if (!pms || typeof pms.createBooking !== "function" ||
      typeof provider !== "string" || !provider.trim()) {
    throw new PmsIntegrationError("PMS_NOT_CONFIGURED", "A hotel reservation-system booking adapter is not configured.", 503);
  }

  let result;
  try {
    result = await pms.createBooking(
      provider,
      buildPmsBookingRequest(booking),
      context,
    );
  } catch {
    return {
      state: "booking_pending",
      confirmed: false,
      requiresStaffReview: true,
      reason: "pms_result_unknown",
      guestMessage: "Your deposit has been verified, but the hotel is still checking the reservation. The hotel team will confirm shortly.",
    };
  }

  if (!result || typeof result.bookingId !== "string" || !result.bookingId.trim()) {
    return {
      state: "booking_pending",
      confirmed: false,
      requiresStaffReview: true,
      reason: "pms_confirmation_missing",
      guestMessage: "Your deposit has been verified, but the hotel is still checking the reservation. The hotel team will confirm shortly.",
    };
  }

  if (result.status !== "confirmed") {
    return {
      state: "booking_pending",
      confirmed: false,
      requiresStaffReview: result.status !== "pending",
      pmsBookingId: result.bookingId,
      reason: result.status === "pending" ? "pms_pending" : "pms_status_not_confirmed",
      guestMessage: "Your deposit has been verified, but the reservation is not confirmed yet. The hotel team will update you shortly.",
    };
  }

  return {
    state: "confirmed",
    confirmed: true,
    requiresStaffReview: false,
    pmsBookingId: result.bookingId,
    paymentProviderId: paymentEvidence.providerPaymentId,
    guestMessage: "Your reservation is confirmed.",
  };
}

module.exports = {
  validateVerifiedDeposit,
  buildPmsBookingRequest,
  createReservationAfterVerifiedDeposit,
};
