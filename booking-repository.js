"use strict";

const crypto = require("node:crypto");
const { PmsIntegrationError, validateDateRange } = require("./pms-integration");
const { normalizeGuestDetails, calculateDeposit } = require("./booking-workflow");

const BOOKING_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS hotel_bookings(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,idempotency_key TEXT NOT NULL,guest_name TEXT NOT NULL,guest_phone TEXT NOT NULL,guest_email TEXT,check_in DATE NOT NULL,check_out DATE NOT NULL,room_type_id TEXT NOT NULL,guest_count INTEGER NOT NULL CHECK(guest_count BETWEEN 1 AND 20),currency CHAR(3) NOT NULL,total_amount_minor BIGINT NOT NULL CHECK(total_amount_minor>0),deposit_amount_minor BIGINT NOT NULL CHECK(deposit_amount_minor>0),balance_amount_minor BIGINT NOT NULL CHECK(balance_amount_minor>=0),state TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK(state IN ('awaiting_payment','payment_pending','payment_verified','booking_pending','confirmed','payment_failed','booking_failed','cancelled')),payment_provider TEXT,payment_provider_payment_id TEXT,payment_verified_at TIMESTAMPTZ,pms_provider TEXT,pms_booking_id TEXT,last_error_code TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(organization_id,idempotency_key),CHECK(deposit_amount_minor+balance_amount_minor=total_amount_minor))",
  "CREATE UNIQUE INDEX IF NOT EXISTS hotel_bookings_payment_reference_idx ON hotel_bookings(organization_id,payment_provider,payment_provider_payment_id) WHERE payment_provider_payment_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS hotel_bookings_pms_reference_idx ON hotel_bookings(organization_id,pms_provider,pms_booking_id) WHERE pms_booking_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS hotel_bookings_org_state_time_idx ON hotel_bookings(organization_id,state,created_at DESC)",
  "CREATE TABLE IF NOT EXISTS payment_webhook_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,provider TEXT NOT NULL,external_event_id TEXT NOT NULL,payload_sha256 CHAR(64) NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT now(),status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','processed','ignored','failed')),processed_at TIMESTAMPTZ,UNIQUE(organization_id,provider,external_event_id))",
  "CREATE INDEX IF NOT EXISTS payment_webhook_events_org_time_idx ON payment_webhook_events(organization_id,received_at DESC)"
];

function fail(code, message, status = 400) {
  throw new PmsIntegrationError(code, message, status);
}

function normalizeBookingRecord(input = {}) {
  const dates = validateDateRange(input);
  const guest = normalizeGuestDetails(input.guest);
  const roomTypeId = typeof input.roomTypeId === "string" ? input.roomTypeId.trim() : "";
  const guestCount = input.guestCount;
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!roomTypeId || roomTypeId.length > 120 ||
      !Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20 ||
      !/^[A-Z]{3}$/.test(currency) ||
      !/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) {
    fail("INVALID_BOOKING_RECORD", "Booking details are incomplete or invalid.");
  }
  const amounts = calculateDeposit(input.totalAmountMinor, 50);
  return { ...dates, guest, roomTypeId, guestCount, currency, idempotencyKey, ...amounts };
}

function bookingFingerprint(value) {
  const canonical = [
    value.guest.name, value.guest.phone, value.guest.email || "",
    value.checkIn, value.checkOut, value.roomTypeId, value.guestCount,
    value.currency, value.totalAmountMinor, value.depositAmountMinor,
  ].join("\u001f");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function inTransaction(db, work) {
  if (!db || typeof db.connect !== "function") fail("DATABASE_UNAVAILABLE", "Booking storage is unavailable.", 503);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function createBookingRecord(db, organizationId, input) {
  if (typeof organizationId !== "string" || !organizationId) fail("INVALID_BOOKING_TENANT", "A hotel workspace is required.");
  const booking = normalizeBookingRecord(input);
  const fingerprint = bookingFingerprint(booking);
  return inTransaction(db, async client => {
    const inserted = await client.query(
      "INSERT INTO hotel_bookings(organization_id,idempotency_key,guest_name,guest_phone,guest_email,check_in,check_out,room_type_id,guest_count,currency,total_amount_minor,deposit_amount_minor,balance_amount_minor,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'awaiting_payment') ON CONFLICT(organization_id,idempotency_key) DO NOTHING RETURNING id,state",
      [organizationId,booking.idempotencyKey,booking.guest.name,booking.guest.phone,booking.guest.email,booking.checkIn,booking.checkOut,booking.roomTypeId,booking.guestCount,booking.currency,booking.totalAmountMinor,booking.depositAmountMinor,booking.balanceAmountMinor]
    );
    if (inserted.rowCount) return { created: true, bookingId: inserted.rows[0].id, state: inserted.rows[0].state };
    const existing = await client.query(
      "SELECT id,guest_name,guest_phone,guest_email,check_in::text,check_out::text,room_type_id,guest_count,currency,total_amount_minor,deposit_amount_minor FROM hotel_bookings WHERE organization_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [organizationId,booking.idempotencyKey]
    );
    if (!existing.rowCount) fail("BOOKING_IDEMPOTENCY_CONFLICT", "The booking request is being processed. Retry with the same request key.", 409);
    const row = existing.rows[0];
    const existingFingerprint = crypto.createHash("sha256").update([
      row.guest_name,row.guest_phone,row.guest_email || "",row.check_in,row.check_out,
      row.room_type_id,row.guest_count,row.currency.trim(),String(row.total_amount_minor),String(row.deposit_amount_minor),
    ].join("\u001f")).digest("hex");
    if (existingFingerprint !== fingerprint) fail("BOOKING_IDEMPOTENCY_COLLISION", "This request key was already used for different booking details.", 409);
    return { created: false, bookingId: row.id, state: "existing" };
  });
}

/**
 * Persist the outcome of the PMS call. A timeout must be recorded as pending,
 * never as confirmed. Only a confirmed provider response with a reference can
 * transition the booking to confirmed.
 */
async function recordPmsOutcome(db, organizationId, bookingId, provider, outcome) {
  if (typeof organizationId !== "string" || !organizationId ||
      typeof bookingId !== "string" || !bookingId ||
      !/^[a-z][a-z0-9_-]{1,39}$/.test(provider || "") ||
      !outcome || !["confirmed", "booking_pending"].includes(outcome.state)) {
    fail("INVALID_PMS_OUTCOME", "A valid hotel reservation outcome is required.");
  }
  const pmsBookingId = typeof outcome.pmsBookingId === "string" ? outcome.pmsBookingId.trim() : "";
  if (outcome.state === "confirmed" && !pmsBookingId) {
    fail("PMS_CONFIRMATION_REFERENCE_REQUIRED", "A confirmed reservation must include its PMS reference.");
  }
  if (pmsBookingId.length > 160) fail("INVALID_PMS_REFERENCE", "The PMS reservation reference is invalid.");
  const errorCode = typeof outcome.reason === "string" && /^[a-z0-9_]{1,80}$/.test(outcome.reason)
    ? outcome.reason : "";
  return inTransaction(db, async client => {
    const found = await client.query(
      "SELECT id,state FROM hotel_bookings WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [bookingId, organizationId]
    );
    if (!found.rowCount) fail("BOOKING_NOT_FOUND", "The booking was not found for this hotel.", 404);
    const current = found.rows[0].state;
    if (current === "confirmed") {
      if (outcome.state === "confirmed") {
        const same = await client.query(
          "SELECT id FROM hotel_bookings WHERE id=$1 AND organization_id=$2 AND pms_provider=$3 AND pms_booking_id=$4",
          [bookingId, organizationId, provider, pmsBookingId]
        );
        if (same.rowCount) return { state: "confirmed", duplicate: true };
      }
      fail("BOOKING_ALREADY_CONFIRMED", "A confirmed reservation cannot be overwritten.", 409);
    }
    if (!["payment_verified", "booking_pending"].includes(current)) {
      fail("PAYMENT_NOT_VERIFIED", "A verified deposit is required before storing a PMS outcome.", 409);
    }
    if (outcome.state === "confirmed") {
      await client.query(
        "UPDATE hotel_bookings SET state='confirmed',pms_provider=$3,pms_booking_id=$4,last_error_code='',updated_at=now() WHERE id=$1 AND organization_id=$2",
        [bookingId, organizationId, provider, pmsBookingId]
      );
      return { state: "confirmed", duplicate: false };
    }
    await client.query(
      "UPDATE hotel_bookings SET state='booking_pending',pms_provider=$3,pms_booking_id=$4,last_error_code=$5,updated_at=now() WHERE id=$1 AND organization_id=$2",
      [bookingId, organizationId, provider, pmsBookingId || null, errorCode || "pms_pending"]
    );
    return { state: "booking_pending", duplicate: false };
  });
}

/**
 * Call only after the provider-specific webhook signature and event schema
 * have been verified. This function independently checks tenant, amount,
 * currency, provider payment ID and booking state in one database transaction.
 */
async function recordVerifiedDeposit(db, organizationId, provider, event) {
  if (typeof organizationId !== "string" || !organizationId ||
      !/^[a-z][a-z0-9_-]{1,39}$/.test(provider || "") ||
      !event || event.signatureVerified !== true ||
      typeof event.eventId !== "string" || !event.eventId.trim() || event.eventId.length > 200 ||
      typeof event.bookingId !== "string" || !event.bookingId ||
      typeof event.paymentId !== "string" || !event.paymentId ||
      !Number.isSafeInteger(event.amountMinor) || event.amountMinor <= 0 ||
      typeof event.currency !== "string" || !/^[A-Z]{3}$/.test(normalizedCurrency)) {
    fail("INVALID_VERIFIED_PAYMENT_EVENT", "A verified, complete payment event is required.", 400);
  }
  const eventId = event.eventId.trim();
  const bookingId = event.bookingId.trim();
  const paymentId = event.paymentId.trim();
  const normalizedCurrency = event.currency.trim().toUpperCase();
  if (eventId.length > 200 || !bookingId || bookingId.length > 100 ||
      !paymentId || paymentId.length > 200) {
    fail("INVALID_VERIFIED_PAYMENT_EVENT", "Payment event identifiers are invalid.", 400);
  }
  const payloadHash = crypto.createHash("sha256").update(JSON.stringify({
    eventId,bookingId,paymentId,
    amountMinor:event.amountMinor,currency:normalizedCurrency,status:event.status,
  })).digest("hex");

  return inTransaction(db, async client => {
    const inserted = await client.query(
      "INSERT INTO payment_webhook_events(organization_id,provider,external_event_id,payload_sha256,status) VALUES($1,$2,$3,$4,'received') ON CONFLICT(organization_id,provider,external_event_id) DO NOTHING RETURNING id",
      [organizationId,provider,eventId,payloadHash]
    );
    if (!inserted.rowCount) {
      const prior = await client.query(
        "SELECT payload_sha256 FROM payment_webhook_events WHERE organization_id=$1 AND provider=$2 AND external_event_id=$3",
        [organizationId,provider,eventId]
      );
      if (!prior.rowCount || prior.rows[0].payload_sha256 !== payloadHash) fail("PAYMENT_EVENT_ID_COLLISION", "The provider reused a payment event ID with different data.", 409);
      return { accepted:false,duplicate:true,state:"already_processed" };
    }
    if (event.status !== "succeeded") {
      await client.query("UPDATE payment_webhook_events SET status='ignored',processed_at=now() WHERE organization_id=$1 AND provider=$2 AND external_event_id=$3",[organizationId,provider,eventId]);
      return { accepted:true,duplicate:false,state:"ignored_non_success" };
    }
    const found = await client.query(
      "SELECT id,state,deposit_amount_minor,currency FROM hotel_bookings WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [bookingId,organizationId]
    );
    if (!found.rowCount) fail("BOOKING_NOT_FOUND", "The booking was not found for this hotel.", 404);
    const booking = found.rows[0];
    if (booking.state === "payment_verified" || booking.state === "booking_pending" || booking.state === "confirmed") {
      const samePayment = await client.query(
        "SELECT id FROM hotel_bookings WHERE organization_id=$1 AND payment_provider=$2 AND payment_provider_payment_id=$3 AND id=$4",
        [organizationId,provider,paymentId,bookingId]
      );
      if (samePayment.rowCount) {
        await client.query("UPDATE payment_webhook_events SET status='processed',processed_at=now() WHERE organization_id=$1 AND provider=$2 AND external_event_id=$3",[organizationId,provider,eventId]);
        return { accepted:true,duplicate:true,state:booking.state };
      }
      fail("BOOKING_ALREADY_PAID", "This booking already has a verified payment.", 409);
    }
    if (!["awaiting_payment","payment_pending"].includes(booking.state)) fail("INVALID_BOOKING_PAYMENT_STATE", "This booking cannot accept a deposit in its current state.", 409);
    if (Number(booking.deposit_amount_minor) !== event.amountMinor || booking.currency.trim() !== normalizedCurrency) {
      fail("PAYMENT_AMOUNT_MISMATCH", "The payment does not match the exact deposit amount and currency.", 409);
    }
    await client.query(
      "UPDATE hotel_bookings SET state='payment_verified',payment_provider=$3,payment_provider_payment_id=$4,payment_verified_at=now(),updated_at=now() WHERE id=$1 AND organization_id=$2",
      [bookingId,organizationId,provider,paymentId]
    );
    await client.query(
      "UPDATE payment_webhook_events SET status='processed',processed_at=now() WHERE organization_id=$1 AND provider=$2 AND external_event_id=$3",
      [organizationId,provider,eventId]
    );
    return { accepted:true,duplicate:false,state:"payment_verified" };
  });
}

module.exports = {
  BOOKING_SCHEMA,
  normalizeBookingRecord,
  createBookingRecord,
  recordVerifiedDeposit,
  recordPmsOutcome,
};
