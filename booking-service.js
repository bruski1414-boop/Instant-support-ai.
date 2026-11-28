"use strict";

const { PmsIntegrationError } = require("./pms-integration");
const { createReservationAfterVerifiedDeposit } = require("./booking-orchestration");

/**
 * Application service boundary: do not return a guest-facing confirmation
 * until the PMS result has also been committed to the hotel's booking record.
 * The caller supplies a tenant-scoped persistence function, normally backed
 * by recordPmsOutcome(db, organizationId, bookingId, provider, outcome).
 */
async function createAndPersistReservation({
  booking,
  bookingId,
  organizationId,
  paymentEvidence,
  pms,
  provider,
  context = {},
  persistOutcome,
}) {
  if (typeof persistOutcome !== "function" ||
      typeof bookingId !== "string" || !bookingId ||
      typeof organizationId !== "string" || !organizationId) {
    throw new PmsIntegrationError("BOOKING_PERSISTENCE_REQUIRED", "A tenant-scoped booking persistence operation is required.", 503);
  }

  const outcome = await createReservationAfterVerifiedDeposit({
    booking, paymentEvidence, pms, provider, context,
  });

  try {
    await persistOutcome(organizationId, bookingId, provider, outcome);
  } catch {
    return {
      state: "booking_pending",
      confirmed: false,
      requiresStaffReview: true,
      reason: "pms_outcome_persistence_failed",
      pmsBookingId: outcome.pmsBookingId,
      guestMessage: "Your deposit has been verified. The hotel team is checking the reservation and will confirm shortly.",
    };
  }

  return outcome;
}

module.exports = { createAndPersistReservation };
