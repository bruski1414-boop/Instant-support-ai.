"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { REPORT_WINDOW_HOURS, createBookingAttributionReportStore } = require("../booking-attribution-report");

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

test("booking attribution report uses an exact 720-hour UTC window and preserves currency minor units", async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [{
          linked_confirmed_bookings: "2",
          distinct_linked_conversations: "1",
          retained_unlinked_reservation_records: "1",
          booking_value_by_currency: [
            { currency: "EUR", amountMinor: "168000", bookingCount: "2" },
            { currency: "JPY", amountMinor: "84000", bookingCount: "1" }
          ],
          latest_reservation_statuses: [
            { status: "cancelled", bookingCount: "1" },
            { status: "confirmed", bookingCount: "1" }
          ]
        }]
      };
    }
  };
  const store = createBookingAttributionReportStore({ pool });
  const report = await store.getReport({
    organizationId: ORGANIZATION_ID,
    now: new Date("2026-11-25T16:00:00.000Z")
  });

  assert.equal(REPORT_WINDOW_HOURS, 720);
  assert.deepEqual(calls[0].params, [
    ORGANIZATION_ID,
    "2026-10-26T16:00:00.000Z",
    "2026-11-25T16:00:00.000Z"
  ]);
  assert.match(calls[0].sql, /organization_id=\$1/);
  assert.match(calls[0].sql, /occurred_at >= \$2::timestamptz/);
  assert.match(calls[0].sql, /occurred_at < \$3::timestamptz/);
  assert.match(calls[0].sql, /conversation_id IS NOT NULL/);
  assert.match(calls[0].sql, /COUNT\(DISTINCT conversation_id\)/);
  assert.equal(report.linkedConfirmedBookings, "2");
  assert.equal(report.distinctLinkedConversations, "1");
  assert.equal(report.retainedUnlinkedReservationRecords, "1");
  assert.deepEqual(report.providerReportedBookingValueByCurrency, [
    { currency: "EUR", amountMinor: "168000", bookingCount: "2" },
    { currency: "JPY", amountMinor: "84000", bookingCount: "1" }
  ]);
  assert.deepEqual(report.latestRecordedReservationStatuses, [
    { status: "cancelled", bookingCount: "1" },
    { status: "confirmed", bookingCount: "1" }
  ]);
  assert.match(report.notice, /not a guaranteed live provider status/);
  assert.equal(report.influencedConversations, "not_measured");
  assert.equal(report.estimatedStaffTimeSaved, "not_calculated");
  assert.equal(report.window.timezone, "UTC");
  assert.equal(report.window.hours, 720);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.providerReportedBookingValueByCurrency), true);
});

test("booking attribution report rejects invalid tenant and time inputs before querying", async () => {
  let queries = 0;
  const store = createBookingAttributionReportStore({
    pool: { query: async () => { queries += 1; return { rows: [] }; } }
  });
  await assert.rejects(store.getReport({ organizationId: "not-a-uuid" }), /organizationId must be a valid UUID/);
  await assert.rejects(store.getReport({ organizationId: ORGANIZATION_ID, now: "not-a-date" }), /now must be a valid date/);
  assert.equal(queries, 0);
});

test("booking attribution report fails closed when the database result is malformed", async () => {
  const store = createBookingAttributionReportStore({
    pool: { query: async () => ({ rows: [{ linked_confirmed_bookings: "not-a-count", booking_value_by_currency: [], latest_reservation_statuses: [] }] }) }
  });
  await assert.rejects(
    store.getReport({ organizationId: ORGANIZATION_ID, now: new Date("2026-11-25T16:00:00.000Z") }),
    /invalid count/
  );
});

test("booking attribution report rejects unsupported lifecycle status values", async () => {
  const store = createBookingAttributionReportStore({
    pool: { query: async () => ({ rows: [{
      linked_confirmed_bookings: "1",
      distinct_linked_conversations: "1",
      retained_unlinked_reservation_records: "0",
      booking_value_by_currency: [],
      latest_reservation_statuses: [{ status: "refunded", bookingCount: "1" }]
    }] }) }
  });
  await assert.rejects(
    store.getReport({ organizationId: ORGANIZATION_ID, now: new Date("2026-11-25T16:00:00.000Z") }),
    /invalid reservation status totals/
  );
});
