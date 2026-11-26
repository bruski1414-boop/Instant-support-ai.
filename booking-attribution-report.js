"use strict";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_WINDOW_HOURS=720;
const REPORT_WINDOW_MS=REPORT_WINDOW_HOURS*60*60*1000;
const RESERVATION_STATUSES=new Set(["confirmed","checked_in","checked_out","cancelled","no_show","unknown","ambiguous"]);
function requiredOrganizationId(value){if(typeof value!=="string"||!UUID.test(value))throw new Error("organizationId must be a valid UUID.");return value.toLowerCase();}
function normalizeNow(value){const date=value instanceof Date?new Date(value.getTime()):new Date(value);if(!Number.isFinite(date.getTime()))throw new Error("now must be a valid date.");return date;}
function createBookingAttributionReportStore({pool}={}){
 if(!pool||typeof pool.query!=="function")throw new Error("A PostgreSQL query-capable pool is required for booking attribution reporting.");
 async function getReport({organizationId,now=new Date()}={}){
  const org=requiredOrganizationId(organizationId),end=normalizeNow(now),endExclusive=end.toISOString(),startInclusive=new Date(end.getTime()-REPORT_WINDOW_MS).toISOString();
  const result=await pool.query(
   `WITH window_matches AS (
    SELECT m.organization_id,m.provider,m.reservation_id,m.conversation_id,m.booking_value_minor,m.currency,COALESCE(latest.latest_status,'unknown') AS latest_status
    FROM booking_attribution_matches m
    LEFT JOIN LATERAL (
     SELECT CASE WHEN COUNT(DISTINCT e.status)>1 THEN 'ambiguous' ELSE MIN(e.status) END AS latest_status
     FROM booking_reservation_lifecycle_events e
     WHERE e.organization_id=m.organization_id AND e.provider=m.provider AND e.reservation_id=m.reservation_id
      AND e.occurred_at=(SELECT MAX(e2.occurred_at) FROM booking_reservation_lifecycle_events e2 WHERE e2.organization_id=m.organization_id AND e2.provider=m.provider AND e2.reservation_id=m.reservation_id)
    ) latest ON TRUE
    WHERE m.organization_id=$1 AND m.occurred_at >= $2::timestamptz AND m.occurred_at < $3::timestamptz
   ),
   summary AS (
    SELECT COUNT(*) FILTER(WHERE conversation_id IS NOT NULL)::text AS linked_confirmed_bookings,
     COUNT(DISTINCT conversation_id) FILTER(WHERE conversation_id IS NOT NULL)::text AS distinct_linked_conversations,
     COUNT(*) FILTER(WHERE conversation_id IS NULL)::text AS retained_unlinked_reservation_records
    FROM window_matches
   ),
   currency_values AS (
    SELECT BTRIM(currency::text) AS currency,SUM(booking_value_minor)::text AS amount_minor,COUNT(*)::text AS booking_count
    FROM window_matches WHERE conversation_id IS NOT NULL AND booking_value_minor IS NOT NULL GROUP BY BTRIM(currency::text)
   ),
   status_values AS (
    SELECT latest_status AS status,COUNT(*)::text AS booking_count FROM window_matches WHERE conversation_id IS NOT NULL GROUP BY latest_status
   )
   SELECT summary.linked_confirmed_bookings,summary.distinct_linked_conversations,summary.retained_unlinked_reservation_records,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('currency',currency,'amountMinor',amount_minor,'bookingCount',booking_count) ORDER BY currency) FROM currency_values),'[]'::jsonb) AS booking_value_by_currency,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('status',status,'bookingCount',booking_count) ORDER BY status) FROM status_values),'[]'::jsonb) AS latest_reservation_statuses
   FROM summary`,
   [org,startInclusive,endExclusive]
  );
  const row=result.rows?.[0];
  if(!row||!Array.isArray(row.booking_value_by_currency)||!Array.isArray(row.latest_reservation_statuses))throw new Error("Booking attribution report returned an invalid database result.");
  const values=row.booking_value_by_currency.map(v=>{
   const currency=typeof v?.currency==="string"?v.currency.trim().toUpperCase():"",amountMinor=typeof v?.amountMinor==="string"?v.amountMinor:String(v?.amountMinor??""),bookingCount=typeof v?.bookingCount==="string"?v.bookingCount:String(v?.bookingCount??"");
   if(!/^[A-Z]{3}$/.test(currency)||!/^\d+$/.test(amountMinor)||!/^\d+$/.test(bookingCount))throw new Error("Booking attribution report contains invalid currency totals.");
   return Object.freeze({currency,amountMinor,bookingCount});
  });
  const statuses=row.latest_reservation_statuses.map(v=>{
   const status=typeof v?.status==="string"?v.status:"",bookingCount=typeof v?.bookingCount==="string"?v.bookingCount:String(v?.bookingCount??"");
   if(!RESERVATION_STATUSES.has(status)||!/^\d+$/.test(bookingCount))throw new Error("Booking attribution report contains invalid reservation status totals.");
   return Object.freeze({status,bookingCount});
  });
  const count=v=>{const n=String(v??"0");if(!/^\d+$/.test(n))throw new Error("Booking attribution report contains an invalid count.");return n;};
  return Object.freeze({
   window:Object.freeze({startInclusive,endExclusive,hours:REPORT_WINDOW_HOURS,timezone:"UTC"}),
   linkedConfirmedBookings:count(row.linked_confirmed_bookings),
   distinctLinkedConversations:count(row.distinct_linked_conversations),
   retainedUnlinkedReservationRecords:count(row.retained_unlinked_reservation_records),
   providerReportedBookingValueByCurrency:Object.freeze(values),
   latestRecordedReservationStatuses:Object.freeze(statuses),
   influencedConversations:"not_measured",
   estimatedStaffTimeSaved:"not_calculated",
   notice:"A linked reservation was confirmed when its Veyra correlation token was matched. Status totals show the latest verified lifecycle event recorded by Veyra, not a guaranteed live provider status. Provider-reported booking value at confirmation is not settled payment or revenue and is not adjusted for later cancellations or payment changes. This report does not prove causation."
  });
 }
 return Object.freeze({getReport});
}
module.exports={REPORT_WINDOW_HOURS,createBookingAttributionReportStore};
