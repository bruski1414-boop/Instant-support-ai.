"use strict";

const BOOKING_STATES = new Set([
  "awaiting_payment", "payment_pending", "payment_verified",
  "booking_pending", "confirmed", "payment_failed", "booking_failed", "cancelled",
]);

function parseBoundedInteger(value, fallback, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) return null;
  return parsed;
}

/**
 * Return only the current hotel's booking records. Guest contact details are
 * exposed only to authenticated hotel workspace staff via the admin route.
 */
async function listHotelBookings({ db, organizationId, state, limit = 50, offset = 0 }) {
  if (!db || typeof db.query !== "function" ||
      typeof organizationId !== "string" || !organizationId) {
    const error = new Error("Hotel booking records are unavailable.");
    error.code = "BOOKING_LIST_NOT_CONFIGURED";
    error.status = 503;
    throw error;
  }
  if (state !== undefined && state !== "" && !BOOKING_STATES.has(state)) {
    const error = new Error("Booking state filter is invalid.");
    error.code = "INVALID_BOOKING_STATE_FILTER";
    error.status = 400;
    throw error;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    const error = new Error("Booking pagination is invalid.");
    error.code = "INVALID_BOOKING_PAGINATION";
    error.status = 400;
    throw error;
  }

  const params = [organizationId];
  let where = "organization_id=$1";
  if (state) {
    params.push(state);
    where += " AND state=$2";
  }
  params.push(limit, offset);
  const limitPosition = params.length - 1;
  const offsetPosition = params.length;
  const result = await db.query(
    `SELECT id,state,guest_name,guest_phone,guest_email,check_in::text AS check_in,check_out::text AS check_out,room_type_id,guest_count,currency,total_amount_minor::text AS total_amount_minor,deposit_amount_minor::text AS deposit_amount_minor,balance_amount_minor::text AS balance_amount_minor,payment_verified_at,pms_provider,pms_booking_id,last_error_code,created_at,updated_at FROM hotel_bookings WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${limitPosition} OFFSET $${offsetPosition}`,
    params
  );
  return { bookings: result.rows, limit, offset };
}

function parseBookingListQuery(query = {}) {
  const limit = parseBoundedInteger(query.limit, 50, 100);
  const offset = parseBoundedInteger(query.offset, 0, 10000);
  if (limit === null || limit === 0 || offset === null) {
    const error = new Error("Booking pagination is invalid.");
    error.code = "INVALID_BOOKING_PAGINATION";
    error.status = 400;
    throw error;
  }
  return { state: query.state || undefined, limit, offset };
}

module.exports = { BOOKING_STATES, listHotelBookings, parseBookingListQuery };
