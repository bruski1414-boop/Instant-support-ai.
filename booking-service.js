"use strict";

const { PmsIntegrationError } = require("./pms-integration");
const { createReservationAfterVerifiedDeposit } = require("./booking-orchestration");
const { loadVerifiedBookingForPms, claimPmsBookingAttempt, recordPmsOutcome } = require("./booking-repository");

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

  let persisted;
  try {
    persisted = await persistOutcome(organizationId, bookingId, provider, outcome);
  } catch {
    persisted = null;
  }

  // A successful promise alone is not proof of a committed state. Require the
  // repository to explicitly report the matching state before guest confirmation.
  if (!persisted || persisted.state !== outcome.state) {
    return {
      state: "booking_pending",
      confirmed: false,
      requiresStaffReview: true,
      reason: "pms_outcome_persistence_unverified",
      pmsBookingId: outcome.pmsBookingId,
      guestMessage: "Your deposit has been verified. The hotel team is checking the reservation and will confirm shortly.",
    };
  }

  return outcome;
}


/**
 * Preferred server entry point: reload trusted booking/payment facts from the
 * database, then persist the PMS outcome through the tenant-scoped repository.
 * A booking already moved to booking_pending is not resubmitted automatically;
 * it requires staff reconciliation to avoid duplicate reservations after an
 * ambiguous PMS timeout.
 */
async function createReservationFromStoredBooking({
  db,
  bookingId,
  organizationId,
  pms,
  provider,
  context = {},
}) {
  const stored = await loadVerifiedBookingForPms(db, organizationId, bookingId);
  const attempt = await claimPmsBookingAttempt(db, organizationId, bookingId, provider);
  if (!attempt.claimed) {
    return {
      state: "booking_pending",
      confirmed: false,
      requiresStaffReview: true,
      reason: "pms_attempt_already_started",
      guestMessage: "Your deposit has been verified. The hotel team is checking the reservation and will confirm shortly.",
    };
  }
  return createAndPersistReservation({
    booking: stored.booking,
    bookingId,
    organizationId,
    paymentEvidence: stored.paymentEvidence,
    pms,
    provider,
    context,
    persistOutcome: (tenantId, id, pmsProvider, outcome) =>
      recordPmsOutcome(db, tenantId, id, pmsProvider, outcome),
  });
}

module.exports = { createAndPersistReservation, createReservationFromStoredBooking };
