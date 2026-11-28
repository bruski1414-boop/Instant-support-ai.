"use strict";

const { PmsIntegrationError, validateDateRange } = require("./pms-integration");
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


/**
 * Build the trusted webhook-to-PMS boundary. Tenant identity and booking ID
 * arrive only from the already-verified payment webhook handler; connection
 * credentials are loaded from that tenant's encrypted PMS connection.
 */
function createVerifiedDepositPmsOrchestrator({
  db,
  vault,
  pmsRegistry,
  createReservation = createReservationFromStoredBooking,
}) {
  if (!db || !vault || !pmsRegistry || typeof createReservation !== "function") {
    throw new PmsIntegrationError("PMS_ORCHESTRATOR_NOT_CONFIGURED", "The hotel reservation service is not configured.", 503);
  }
  return async ({ organizationId, bookingId }) => {
    const current = await db.query(
      "SELECT state FROM hotel_bookings WHERE id=$1 AND organization_id=$2",
      [bookingId, organizationId]
    );
    if (!current.rowCount) {
      return { state: "booking_pending", confirmed: false, requiresStaffReview: true, reason: "booking_not_found" };
    }
    if (current.rows[0].state === "booking_pending" || current.rows[0].state === "confirmed") {
      return {
        state: current.rows[0].state,
        confirmed: current.rows[0].state === "confirmed",
        requiresStaffReview: current.rows[0].state !== "confirmed",
      };
    }
    if (current.rows[0].state !== "payment_verified") {
      return { state: current.rows[0].state, confirmed: false, requiresStaffReview: true, reason: "payment_not_verified" };
    }

    const connection = await db.query(
      "SELECT provider,encrypted_credentials FROM pms_connections WHERE organization_id=$1 AND status='connected' ORDER BY connected_at DESC LIMIT 1",
      [organizationId]
    );
    if (!connection.rowCount) {
      return { state: "payment_verified", confirmed: false, requiresStaffReview: true, reason: "pms_connection_missing" };
    }

    let credentials;
    try {
      credentials = vault.decrypt(connection.rows[0].encrypted_credentials);
    } catch {
      return { state: "payment_verified", confirmed: false, requiresStaffReview: true, reason: "pms_credentials_unavailable" };
    }

    const provider = connection.rows[0].provider;
    const pms = {
      createBooking: (requestedProvider, input, context = {}) =>
        pmsRegistry.createBooking(requestedProvider, input, { ...context, credentials }),
    };
    return createReservation({
      db, organizationId, bookingId, provider, pms, context: { credentials },
    });
  };
}


/**
 * Read live room inventory from the PMS connection owned by this hotel.
 * No client-supplied provider or credentials are accepted; both come from the
 * tenant-scoped connection record. An absent/invalid connection is UNKNOWN,
 * never an assertion that rooms are sold out or available.
 */
async function getHotelAvailability({ db, vault, pmsRegistry, organizationId, checkIn, checkOut }) {
  if (!db || typeof db.query !== "function" ||
      typeof organizationId !== "string" || !organizationId ||
      !vault || typeof vault.decrypt !== "function" ||
      !pmsRegistry || typeof pmsRegistry.getAvailability !== "function") {
    throw new PmsIntegrationError("AVAILABILITY_NOT_CONFIGURED", "Hotel availability lookup is not configured.", 503);
  }
  const dates = validateDateRange({ checkIn, checkOut });
  const connection = await db.query(
    "SELECT provider,encrypted_credentials FROM pms_connections WHERE organization_id=$1 AND status='connected' ORDER BY connected_at DESC LIMIT 1",
    [organizationId]
  );
  if (!connection.rowCount) {
    return { status: "unknown", reason: "pms_connection_missing", checkedAt: null, rooms: [] };
  }
  let credentials;
  try {
    credentials = vault.decrypt(connection.rows[0].encrypted_credentials);
  } catch {
    return { status: "unknown", reason: "pms_credentials_unavailable", checkedAt: null, rooms: [] };
  }
  try {
    const rooms = await pmsRegistry.getAvailability(
      connection.rows[0].provider,
      dates,
      { credentials, organizationId }
    );
    return { status: "checked", reason: null, checkedAt: new Date().toISOString(), rooms };
  } catch (error) {
    if (error && ["PROVIDER_UNAVAILABLE", "CAPABILITY_UNAVAILABLE", "PROVIDER_CREDENTIALS_REQUIRED", "INVALID_CREDENTIALS", "PROVIDER_SCOPE_MISSING"].includes(error.code)) {
      return { status: "unknown", reason: "pms_availability_not_ready", checkedAt: null, rooms: [] };
    }
    throw error;
  }
}

module.exports = { createAndPersistReservation, createReservationFromStoredBooking, createVerifiedDepositPmsOrchestrator, getHotelAvailability };
