"use strict";

const { PmsIntegrationError } = require("./pms-integration");
const { getHotelAvailability } = require("./booking-service");

const AVAILABILITY_QUOTE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS hotel_availability_quotes(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,room_type_id TEXT NOT NULL,room_type_name TEXT NOT NULL,check_in DATE NOT NULL,check_out DATE NOT NULL,guest_count INTEGER NOT NULL CHECK(guest_count BETWEEN 1 AND 20),currency CHAR(3) NOT NULL,amount_minor BIGINT NOT NULL CHECK(amount_minor>0),available_units INTEGER NOT NULL CHECK(available_units>0),checked_at TIMESTAMPTZ NOT NULL,expires_at TIMESTAMPTZ NOT NULL,consumed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(check_out>check_in),CHECK(expires_at>checked_at))",
  "CREATE INDEX IF NOT EXISTS hotel_availability_quotes_tenant_expiry_idx ON hotel_availability_quotes(organization_id,expires_at DESC)"
];

async function createAvailabilityQuotes({ db, vault, pmsRegistry, organizationId, checkIn, checkOut, guestCount = 1, ttlSeconds = 900 }) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 1800) {
    throw new PmsIntegrationError("INVALID_QUOTE_TTL", "Availability quote lifetime is invalid.");
  }
  const availability = await getHotelAvailability({
    db, vault, pmsRegistry, organizationId, checkIn, checkOut, guestCount,
  });
  if (availability.status !== "checked") {
    return { ...availability, quotes: [] };
  }

  const eligible = availability.rooms.filter(room =>
    room && typeof room.roomTypeId === "string" && room.roomTypeId.length > 0 &&
    typeof room.roomTypeName === "string" && room.roomTypeName.length > 0 &&
    /^[A-Z]{3}$/.test(room.currency) &&
    Number.isSafeInteger(room.amountMinor) && room.amountMinor > 0 &&
    Number.isSafeInteger(room.availableUnits) && room.availableUnits > 0
  );
  if (!eligible.length) {
    return { ...availability, quotes: [], reason: "no_bookable_rate" };
  }
  if (!db || typeof db.connect !== "function") {
    throw new PmsIntegrationError("DATABASE_UNAVAILABLE", "Availability quotes cannot be saved.", 503);
  }

  const dates = { checkIn, checkOut };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const quotes = [];
    for (const room of eligible) {
      const saved = await client.query(
        "INSERT INTO hotel_availability_quotes(organization_id,room_type_id,room_type_name,check_in,check_out,guest_count,currency,amount_minor,available_units,checked_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+($11::int*interval '1 second')) RETURNING id,room_type_id,room_type_name,check_in::text,check_out::text,guest_count,currency,amount_minor::text,available_units,checked_at,expires_at",
        [organizationId,room.roomTypeId,room.roomTypeName,dates.checkIn,dates.checkOut,guestCount,room.currency,room.amountMinor,room.availableUnits,availability.checkedAt,ttlSeconds]
      );
      const row = saved.rows[0];
      const amountMinor = Number(row.amount_minor);
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        throw new PmsIntegrationError("INVALID_PROVIDER_RESPONSE", "Saved room quote amount is outside the supported range.", 502);
      }
      quotes.push({
        quoteId: row.id,
        roomTypeId: row.room_type_id,
        roomTypeName: row.room_type_name,
        checkIn: row.check_in,
        checkOut: row.check_out,
        guestCount: Number(row.guest_count),
        currency: row.currency.trim(),
        amountMinor,
        availableUnits: Number(row.available_units),
        checkedAt: row.checked_at,
        expiresAt: row.expires_at,
      });
    }
    await client.query("COMMIT");
    return { status: "checked", reason: null, checkedAt: availability.checkedAt, quotes };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { AVAILABILITY_QUOTE_SCHEMA, createAvailabilityQuotes };
