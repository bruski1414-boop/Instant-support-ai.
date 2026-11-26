"use strict";
const {isVerifiedReservationLifecycleEvidence}=require("./booking-reservation-lifecycle");
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requiredOrg(v){if(typeof v!=="string"||!UUID.test(v))throw new Error("organizationId must be a valid UUID.");return v.toLowerCase();}
function timestamp(v){const d=v instanceof Date?v:new Date(v);if(!Number.isFinite(d.getTime()))throw new Error("Database returned an invalid lifecycle timestamp.");return d.toISOString();}
function sameEvent(row,e){return row.reservation_id===e.reservationId&&row.status===e.status&&timestamp(row.occurred_at)===e.occurredAt&&row.verification_method===e.verificationMethod;}
function createBookingReservationLifecycleStore({pool}={}){
 if(!pool||typeof pool.connect!=="function"||typeof pool.query!=="function")throw new Error("A PostgreSQL pool is required for reservation lifecycle persistence.");
 async function recordStatus({organizationId,verifiedEvidence}={}){
  const org=requiredOrg(organizationId);
  if(!isVerifiedReservationLifecycleEvidence(verifiedEvidence))throw new Error("A provider-verified reservation lifecycle evidence object is required.");
  if(verifiedEvidence.organizationId!==org)throw new Error("Reservation lifecycle evidence belongs to a different hotel workspace.");
  const client=await pool.connect();let open=false;
  try{
   await client.query("BEGIN");open=true;
   const match=await client.query("SELECT id FROM booking_attribution_matches WHERE organization_id=$1 AND provider=$2 AND reservation_id=$3 FOR UPDATE",[org,verifiedEvidence.provider,verifiedEvidence.reservationId]);
   if(!match.rowCount){await client.query("ROLLBACK");open=false;return Object.freeze({status:"unmatched"});}
   const existing=await client.query("SELECT reservation_id,status,occurred_at,verification_method FROM booking_reservation_lifecycle_events WHERE organization_id=$1 AND provider=$2 AND provider_event_id=$3",[org,verifiedEvidence.provider,verifiedEvidence.eventId]);
   if(existing.rowCount){const exact=sameEvent(existing.rows[0],verifiedEvidence);await client.query("ROLLBACK");open=false;if(exact)return Object.freeze({status:"duplicate"});throw new Error("Provider lifecycle event ID was reused with conflicting evidence.");}
   const inserted=await client.query("INSERT INTO booking_reservation_lifecycle_events(organization_id,provider,provider_event_id,reservation_id,status,occurred_at,verification_method) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",[org,verifiedEvidence.provider,verifiedEvidence.eventId,verifiedEvidence.reservationId,verifiedEvidence.status,verifiedEvidence.occurredAt,verifiedEvidence.verificationMethod]);
   await client.query("INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id) VALUES($1,NULL,'booking_attribution.reservation_status_recorded','booking_attribution_match',$2)",[org,match.rows[0].id]);
   await client.query("COMMIT");open=false;return Object.freeze({status:"recorded",eventId:inserted.rows[0].id});
  }catch(error){
   if(open)await client.query("ROLLBACK").catch(()=>{});
   if(error?.code==="23505"){const existing=await pool.query("SELECT reservation_id,status,occurred_at,verification_method FROM booking_reservation_lifecycle_events WHERE organization_id=$1 AND provider=$2 AND provider_event_id=$3",[org,verifiedEvidence.provider,verifiedEvidence.eventId]);if(existing.rowCount&&sameEvent(existing.rows[0],verifiedEvidence))return Object.freeze({status:"duplicate"});if(existing.rowCount)throw new Error("Provider lifecycle event ID was reused with conflicting evidence.");}
   throw error;
  }finally{client.release();}
 }
 return Object.freeze({recordStatus});
}
module.exports={createBookingReservationLifecycleStore};
