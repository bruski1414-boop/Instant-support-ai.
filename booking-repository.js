"use strict";

const crypto = require("node:crypto");
const { PmsIntegrationError, validateDateRange } = require("./pms-integration");
const { normalizeGuestDetails, calculateDeposit } = require("./booking-workflow");

const BOOKING_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS organization_payment_connections(organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,provider TEXT NOT NULL,encrypted_webhook_secret TEXT NOT NULL,webhook_endpoint_token_hash CHAR(64),status TEXT NOT NULL DEFAULT 'configured' CHECK(status IN ('configured','disabled')),connected_by UUID REFERENCES users(id) ON DELETE SET NULL,connected_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,provider))",
  "ALTER TABLE organization_payment_connections ADD COLUMN IF NOT EXISTS webhook_endpoint_token_hash CHAR(64)",
  "ALTER TABLE organization_payment_connections ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ",
  "CREATE UNIQUE INDEX IF NOT EXISTS organization_payment_endpoint_token_idx ON organization_payment_connections(webhook_endpoint_token_hash) WHERE webhook_endpoint_token_hash IS NOT NULL",
  "CREATE TABLE IF NOT EXISTS hotel_bookings(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,quote_id UUID,idempotency_key TEXT NOT NULL,guest_name TEXT NOT NULL,guest_phone TEXT NOT NULL,guest_email TEXT,check_in DATE NOT NULL,check_out DATE NOT NULL,room_type_id TEXT NOT NULL,guest_count INTEGER NOT NULL CHECK(guest_count BETWEEN 1 AND 20),currency CHAR(3) NOT NULL,total_amount_minor BIGINT NOT NULL CHECK(total_amount_minor>0),deposit_amount_minor BIGINT NOT NULL CHECK(deposit_amount_minor>0),balance_amount_minor BIGINT NOT NULL CHECK(balance_amount_minor>=0),state TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK(state IN ('awaiting_payment','payment_pending','payment_verified','booking_pending','confirmed','payment_failed','booking_failed','cancelled')),payment_provider TEXT,payment_provider_payment_id TEXT,payment_verified_at TIMESTAMPTZ,pms_provider TEXT,pms_booking_id TEXT,last_error_code TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(organization_id,idempotency_key),CHECK(deposit_amount_minor+balance_amount_minor=total_amount_minor))",
  "ALTER TABLE hotel_bookings ADD COLUMN IF NOT EXISTS quote_id UUID",
  "CREATE UNIQUE INDEX IF NOT EXISTS hotel_bookings_quote_idx ON hotel_bookings(organization_id,quote_id) WHERE quote_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS hotel_bookings_payment_reference_idx ON hotel_bookings(organization_id,payment_provider,payment_provider_payment_id) WHERE payment_provider_payment_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS hotel_bookings_pms_reference_idx ON hotel_bookings(organization_id,pms_provider,pms_booking_id) WHERE pms_booking_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS hotel_bookings_org_state_time_idx ON hotel_bookings(organization_id,state,created_at DESC)",
  "CREATE TABLE IF NOT EXISTS hotel_pms_booking_attempts(organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,booking_id UUID NOT NULL REFERENCES hotel_bookings(id) ON DELETE CASCADE,provider TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','confirmed','pending')),pms_booking_id TEXT,started_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,booking_id))",
  "CREATE TABLE IF NOT EXISTS staff_booking_notification_outbox(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,booking_id UUID NOT NULL REFERENCES hotel_bookings(id) ON DELETE CASCADE,event_type TEXT NOT NULL DEFAULT 'booking_requested' CHECK(event_type='booking_requested'),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','delivered','dead_letter')),attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),lease_expires_at TIMESTAMPTZ,last_attempt_at TIMESTAMPTZ,delivered_at TIMESTAMPTZ,last_error_code TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(organization_id,booking_id,event_type))",
  "CREATE INDEX IF NOT EXISTS staff_booking_notification_due_idx ON staff_booking_notification_outbox(status,next_attempt_at) WHERE status IN ('pending','processing')",
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
/**
 * Load the authoritative booking and payment evidence for PMS orchestration.
 * Both records come from the tenant-scoped database row; webhook/client fields
 * are never accepted as a source of booking amounts or payment identity.
 */

/**
 * Create a booking from a persisted tenant-owned PMS quote. Price, room and
 * stay details are read under a row lock; no commercial fields come from guest input.
 */
async function createBookingRecordFromQuote(db, organizationId, input = {}) {
  if (typeof organizationId !== "string" || !organizationId) fail("INVALID_BOOKING_TENANT", "A hotel workspace is required.");
  const quoteId = typeof input.quoteId === "string" ? input.quoteId.trim() : "";
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(quoteId) ||
      !/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) {
    fail("INVALID_BOOKING_REQUEST", "A valid quote reference and request key are required.");
  }
  const guest = normalizeGuestDetails(input.guest);
  return inTransaction(db, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [organizationId + ":" + idempotencyKey]);
    const existing = await client.query(
      "SELECT id,quote_id,guest_name,guest_phone,guest_email,state FROM hotel_bookings WHERE organization_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [organizationId,idempotencyKey]
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.quote_id !== quoteId || row.guest_name !== guest.name ||
          row.guest_phone !== guest.phone || (row.guest_email || null) !== (guest.email || null)) {
        fail("BOOKING_IDEMPOTENCY_COLLISION", "This request key was already used for different booking details.", 409);
      }
      return { created: false, bookingId: row.id, state: row.state };
    }
    const selected = await client.query(
      "SELECT id,room_type_id,check_in::text,check_out::text,guest_count,currency,amount_minor::text,available_units FROM hotel_availability_quotes WHERE id=$1 AND organization_id=$2 AND consumed_at IS NULL AND expires_at>now() AND checked_at>now()-interval '5 minutes' FOR UPDATE",
      [quoteId,organizationId]
    );
    if (!selected.rowCount) fail("QUOTE_INVALID_OR_EXPIRED", "This room quote has expired or is no longer available. Please check availability again.", 409);
    const quote = selected.rows[0];
    const totalAmountMinor = Number(quote.amount_minor);
    const guestCount = Number(quote.guest_count);
    const availableUnits = Number(quote.available_units);
    const currency = String(quote.currency).trim();
    if (!Number.isSafeInteger(totalAmountMinor) || totalAmountMinor <= 0 ||
        !Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20 ||
        !Number.isInteger(availableUnits) || availableUnits < 1 || !/^[A-Z]{3}$/.test(currency)) {
      fail("INVALID_STORED_QUOTE", "The stored room quote is invalid and cannot be booked.", 409);
    }
    const amounts = calculateDeposit(totalAmountMinor, 50);
    const consumed = await client.query(
      "UPDATE hotel_availability_quotes SET consumed_at=now() WHERE id=$1 AND organization_id=$2 AND consumed_at IS NULL AND expires_at>now() AND checked_at>now()-interval '5 minutes' RETURNING id",
      [quoteId,organizationId]
    );
    if (!consumed.rowCount) fail("QUOTE_ALREADY_USED", "This room quote has already been used. Please check availability again.", 409);
    const inserted = await client.query(
      "INSERT INTO hotel_bookings(organization_id,quote_id,idempotency_key,guest_name,guest_phone,guest_email,check_in,check_out,room_type_id,guest_count,currency,total_amount_minor,deposit_amount_minor,balance_amount_minor,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'awaiting_payment') RETURNING id,state",
      [organizationId,quoteId,idempotencyKey,guest.name,guest.phone,guest.email,quote.check_in,quote.check_out,quote.room_type_id,guestCount,currency,totalAmountMinor,amounts.depositAmountMinor,amounts.balanceAmountMinor]
    );
    return { created: true, bookingId: inserted.rows[0].id, state: inserted.rows[0].state, currency, totalAmountMinor, depositAmountMinor: amounts.depositAmountMinor, balanceAmountMinor: amounts.balanceAmountMinor };
  });
}

async function loadVerifiedBookingForPms(db, organizationId, bookingId) {
  if (typeof organizationId !== "string" || !organizationId ||
      typeof bookingId !== "string" || !bookingId) {
    fail("INVALID_BOOKING_LOOKUP", "A hotel and booking reference are required.");
  }
  if (!db || typeof db.query !== "function") {
    fail("DATABASE_UNAVAILABLE", "Booking storage is unavailable.", 503);
  }
  const result = await db.query(
    "SELECT id,state,idempotency_key,guest_name,guest_phone,guest_email,check_in::text,check_out::text,room_type_id,guest_count,currency,total_amount_minor,deposit_amount_minor,payment_provider,payment_provider_payment_id,payment_verified_at FROM hotel_bookings WHERE id=$1 AND organization_id=$2",
    [bookingId, organizationId]
  );
  if (!result.rowCount) fail("BOOKING_NOT_FOUND", "The booking was not found for this hotel.", 404);
  const row = result.rows[0];
  if (row.state !== "payment_verified" || !row.payment_verified_at ||
      typeof row.payment_provider !== "string" || !row.payment_provider ||
      typeof row.payment_provider_payment_id !== "string" || !row.payment_provider_payment_id) {
    fail("PAYMENT_NOT_VERIFIED", "A persisted, verified deposit is required before PMS booking.", 409);
  }
  const booking = {
    id: row.id,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    guest: { name: row.guest_name, phone: row.guest_phone, email: row.guest_email || "" },
    checkIn: row.check_in,
    checkOut: row.check_out,
    roomTypeId: row.room_type_id,
    guestCount: Number(row.guest_count),
    currency: String(row.currency).trim(),
    totalAmountMinor: Number(row.total_amount_minor),
    depositAmountMinor: Number(row.deposit_amount_minor),
  };
  const paymentEvidence = {
    verified: true,
    status: "succeeded",
    providerPaymentId: row.payment_provider_payment_id,
    amountMinor: booking.depositAmountMinor,
    currency: booking.currency,
  };
  return { booking, paymentEvidence, paymentProvider: row.payment_provider };
}

/**
 * Atomically claim the one permitted automatic PMS submission for a booking.
 * A pre-existing attempt is never submitted again automatically: it may have
 * reached the PMS even if Veyra lost the response.
 */
async function claimPmsBookingAttempt(db, organizationId, bookingId, provider) {
  if (!db || typeof db.connect !== "function" ||
      typeof organizationId !== "string" || !organizationId ||
      typeof bookingId !== "string" || !bookingId ||
      !/^[a-z][a-z0-9_-]{1,39}$/.test(provider || "")) {
    fail("INVALID_PMS_ATTEMPT", "A valid tenant-scoped PMS attempt is required.");
  }
  return inTransaction(db, async client => {
    const booking = await client.query(
      "SELECT state FROM hotel_bookings WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [bookingId, organizationId]
    );
    if (!booking.rowCount) fail("BOOKING_NOT_FOUND", "The booking was not found for this hotel.", 404);
    if (booking.rows[0].state !== "payment_verified") {
      fail("PAYMENT_NOT_VERIFIED", "Only a newly verified booking can start PMS submission.", 409);
    }
    const claimed = await client.query(
      "INSERT INTO hotel_pms_booking_attempts(organization_id,booking_id,provider,status) VALUES($1,$2,$3,'started') ON CONFLICT(organization_id,booking_id) DO NOTHING RETURNING booking_id",
      [organizationId, bookingId, provider]
    );
    return { claimed: Boolean(claimed.rowCount) };
  });
}

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
    if (current !== "payment_verified") {
      fail("PAYMENT_NOT_VERIFIED", "A verified deposit and active PMS attempt are required before storing a PMS outcome.", 409);
    }
    const attempt = await client.query(
      "SELECT provider,status FROM hotel_pms_booking_attempts WHERE organization_id=$1 AND booking_id=$2 FOR UPDATE",
      [organizationId, bookingId]
    );
    if (!attempt.rowCount || attempt.rows[0].provider !== provider || attempt.rows[0].status !== "started") {
      fail("PMS_ATTEMPT_NOT_ACTIVE", "The matching PMS submission attempt is not active.", 409);
    }
    if (outcome.state === "confirmed") {
      await client.query(
        "UPDATE hotel_bookings SET state='confirmed',pms_provider=$3,pms_booking_id=$4,last_error_code='',updated_at=now() WHERE id=$1 AND organization_id=$2",
        [bookingId, organizationId, provider, pmsBookingId]
      );
      await client.query(
        "UPDATE hotel_pms_booking_attempts SET status='confirmed',pms_booking_id=$3,updated_at=now() WHERE organization_id=$1 AND booking_id=$2 AND provider=$4",
        [organizationId, bookingId, pmsBookingId, provider]
      );
      return { state: "confirmed", duplicate: false };
    }
    await client.query(
      "UPDATE hotel_bookings SET state='booking_pending',pms_provider=$3,pms_booking_id=$4,last_error_code=$5,updated_at=now() WHERE id=$1 AND organization_id=$2",
      [bookingId, organizationId, provider, pmsBookingId || null, errorCode || "pms_pending"]
    );
    await client.query(
      "UPDATE hotel_pms_booking_attempts SET status='pending',pms_booking_id=$3,updated_at=now() WHERE organization_id=$1 AND booking_id=$2 AND provider=$4",
      [organizationId, bookingId, pmsBookingId || null, provider]
    );
    return { state: "booking_pending", duplicate: false };
  });
}

/**
 * Reconcile an uncertain PMS submission using an authoritative, normalized
 * lookup result. This never creates or resubmits a provider reservation.
 * The stored provider/reference must match the lookup result exactly.
 */
async function recordReconciledPmsOutcome(db, organizationId, bookingId, provider, lookup) {
  if (typeof organizationId !== "string" || !organizationId ||
      typeof bookingId !== "string" || !bookingId ||
      !/^[a-z][a-z0-9_-]{1,39}$/.test(provider || "") ||
      !lookup || typeof lookup.bookingId !== "string" ||
      !lookup.bookingId.trim() || lookup.bookingId.length > 160 ||
      !["confirmed", "pending", "not_found"].includes(lookup.status)) {
    fail("INVALID_PMS_RECONCILIATION", "A valid authoritative PMS lookup result is required.");
  }
  const reference = lookup.bookingId.trim();
  if (/[\x00-\x1f\x7f]/.test(reference)) {
    fail("INVALID_PMS_REFERENCE", "The PMS reservation reference is invalid.");
  }
  return inTransaction(db, async client => {
    const found = await client.query(
      "SELECT id,state,pms_provider,pms_booking_id FROM hotel_bookings WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [bookingId, organizationId]
    );
    if (!found.rowCount) fail("BOOKING_NOT_FOUND", "The booking was not found for this hotel.", 404);
    const row = found.rows[0];
    if (row.state === "confirmed") {
      if (row.pms_provider === provider && row.pms_booking_id === reference && lookup.status === "confirmed") {
        return { state: "confirmed", duplicate: true };
      }
      fail("BOOKING_ALREADY_CONFIRMED", "A confirmed reservation cannot be overwritten.", 409);
    }
    if (row.state !== "booking_pending" || row.pms_provider !== provider ||
        row.pms_booking_id !== reference) {
      fail("PMS_RECONCILIATION_MISMATCH", "The lookup does not match this booking's stored pending PMS reservation.", 409);
    }
    const attempt = await client.query(
      "SELECT provider,status,pms_booking_id FROM hotel_pms_booking_attempts WHERE organization_id=$1 AND booking_id=$2 FOR UPDATE",
      [organizationId, bookingId]
    );
    if (!attempt.rowCount || attempt.rows[0].provider !== provider ||
        attempt.rows[0].status !== "pending" || attempt.rows[0].pms_booking_id !== reference) {
      fail("PMS_ATTEMPT_NOT_RECONCILABLE", "The matching pending PMS attempt could not be verified.", 409);
    }
    if (lookup.status === "confirmed") {
      await client.query(
        "UPDATE hotel_bookings SET state='confirmed',last_error_code='',updated_at=now() WHERE id=$1 AND organization_id=$2 AND state='booking_pending' AND pms_provider=$3 AND pms_booking_id=$4",
        [bookingId, organizationId, provider, reference]
      );
      await client.query(
        "UPDATE hotel_pms_booking_attempts SET status='confirmed',updated_at=now() WHERE organization_id=$1 AND booking_id=$2 AND provider=$3 AND status='pending' AND pms_booking_id=$4",
        [organizationId, bookingId, provider, reference]
      );
      return { state: "confirmed", duplicate: false };
    }
    if (lookup.status === "not_found") {
      await client.query(
        "UPDATE hotel_bookings SET last_error_code='pms_lookup_not_found',updated_at=now() WHERE id=$1 AND organization_id=$2 AND state='booking_pending' AND pms_provider=$3 AND pms_booking_id=$4",
        [bookingId, organizationId, provider, reference]
      );
    }
    return { state: "booking_pending", duplicate: false, lookupStatus: lookup.status };
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
      typeof event.bookingId !== "string" || !event.bookingId.trim() ||
      typeof event.paymentId !== "string" || !event.paymentId.trim() ||
      !Number.isSafeInteger(event.amountMinor) || event.amountMinor <= 0 ||
      typeof event.currency !== "string" || !/^[A-Za-z]{3}$/.test(event.currency.trim())) {
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
  createBookingRecordFromQuote,
  loadVerifiedBookingForPms,
  claimPmsBookingAttempt,
  recordVerifiedDeposit,
  recordPmsOutcome,
  recordReconciledPmsOutcome,
};
