"use strict";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_WINDOW_HOURS = 720;
const REPORT_WINDOW_MS = REPORT_WINDOW_HOURS * 60 * 60 * 1000;

function requiredOrganizationId(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("organizationId must be a valid UUID.");
  }
  return value.toLowerCase();
}

function normalizeNow(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("now must be a valid date.");
  return date;
}

function createBookingAttributionReportStore({ pool } = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("A PostgreSQL query-capable pool is required for booking attribution reporting.");
  }

  async function getReport({ organizationId, now = new Date() } = {}) {
    const safeOrganizationId = requiredOrganizationId(organizationId);
    const end = normalizeNow(now);
    const endExclusive = end.toISOString();
    const startInclusive = new Date(end.getTime() - REPORT_WINDOW_MS).toISOString();

    const result = await pool.query(
      `WITH window_matches AS (
        SELECT conversation_id, booking_value_minor, currency
        FROM booking_attribution_matches
        WHERE organization_id=$1
          AND occurred_at >= $2::timestamptz
          AND occurred_at < $3::timestamptz
      ),
      summary AS (
        SELECT
          COUNT(*) FILTER (WHERE conversation_id IS NOT NULL)::text AS linked_confirmed_bookings,
          COUNT(DISTINCT conversation_id) FILTER (WHERE conversation_id IS NOT NULL)::text AS distinct_linked_conversations,
          COUNT(*) FILTER (WHERE conversation_id IS NULL)::text AS retained_unlinked_reservation_records
        FROM window_matches
      ),
      currency_values AS (
        SELECT
          BTRIM(currency::text) AS currency,
          SUM(booking_value_minor)::text AS amount_minor,
          COUNT(*)::text AS booking_count
        FROM window_matches
        WHERE conversation_id IS NOT NULL
          AND booking_value_minor IS NOT NULL
        GROUP BY BTRIM(currency::text)
      )
      SELECT
        summary.linked_confirmed_bookings,
        summary.distinct_linked_conversations,
        summary.retained_unlinked_reservation_records,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'currency', currency,
                'amountMinor', amount_minor,
                'bookingCount', booking_count
              ) ORDER BY currency
            )
            FROM currency_values
          ),
          '[]'::jsonb
        ) AS booking_value_by_currency
      FROM summary`,
      [safeOrganizationId, startInclusive, endExclusive]
    );

    const row = result.rows?.[0];
    if (!row || !Array.isArray(row.booking_value_by_currency)) {
      throw new Error("Booking attribution report returned an invalid database result.");
    }

    const values = row.booking_value_by_currency.map(value => {
      const currency = typeof value?.currency === "string" ? value.currency.trim().toUpperCase() : "";
      const amountMinor = typeof value?.amountMinor === "string" ? value.amountMinor : String(value?.amountMinor ?? "");
      const bookingCount = typeof value?.bookingCount === "string" ? value.bookingCount : String(value?.bookingCount ?? "");
      if (!/^[A-Z]{3}$/.test(currency) || !/^\d+$/.test(amountMinor) || !/^\d+$/.test(bookingCount)) {
        throw new Error("Booking attribution report contains invalid currency totals.");
      }
      return Object.freeze({ currency, amountMinor, bookingCount });
    });

    const count = value => {
      const normalized = String(value ?? "0");
      if (!/^\d+$/.test(normalized)) throw new Error("Booking attribution report contains an invalid count.");
      return normalized;
    };

    return Object.freeze({
      window: Object.freeze({
        startInclusive,
        endExclusive,
        hours: REPORT_WINDOW_HOURS,
        timezone: "UTC"
      }),
      linkedConfirmedBookings: count(row.linked_confirmed_bookings),
      distinctLinkedConversations: count(row.distinct_linked_conversations),
      retainedUnlinkedReservationRecords: count(row.retained_unlinked_reservation_records),
      providerReportedBookingValueByCurrency: Object.freeze(values),
      influencedConversations: "not_measured",
      estimatedStaffTimeSaved: "not_calculated",
      notice: "A linked booking is a provider-confirmed reservation event that echoed a Veyra correlation token. Provider-reported booking value is not settled payment or revenue. This report does not prove causation or current reservation status."
    });
  }

  return Object.freeze({ getReport });
}

module.exports = { REPORT_WINDOW_HOURS, createBookingAttributionReportStore };
