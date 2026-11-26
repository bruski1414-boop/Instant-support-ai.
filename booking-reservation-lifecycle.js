"use strict";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER=/^[a-z][a-z0-9_-]{1,39}$/;
const IDENTIFIER=/^[A-Za-z0-9._:/# -]{1,200}$/;
const UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STATUSES=new Set(["confirmed","checked_in","checked_out","cancelled","no_show"]);
const METHODS=new Set(["signed_webhook","api_readback"]);
const VERIFIED=new WeakSet();
function uuid(v){if(typeof v!=="string"||!UUID.test(v))throw new Error("organizationId must be a valid UUID.");return v.toLowerCase();}
function provider(v){if(typeof v!=="string"||!PROVIDER.test(v.trim()))throw new Error("A trusted provider identifier is required.");return v.trim();}
function identifier(v,field){if(typeof v!=="string"||!IDENTIFIER.test(v.trim())||v.split("").some(c=>c.charCodeAt(0)<32))throw new Error(field+" must be a valid provider identifier.");return v.trim();}
function utc(v){if(typeof v!=="string"||!UTC.test(v))throw new Error("occurredAt must be an ISO-8601 UTC timestamp.");const ms=Date.parse(v);if(!Number.isFinite(ms))throw new Error("occurredAt must be a valid timestamp.");const canonical=new Date(ms).toISOString();const supplied=v.includes(".")?v.replace(/(\.\d{1,2})Z$/,m=>m.slice(0,-1).padEnd(4,"0")+"Z"):v.replace("Z",".000Z");if(canonical!==supplied)throw new Error("occurredAt must be a real UTC calendar timestamp.");return canonical;}
async function createVerifiedReservationLifecycleEvidence({organizationId,provider:providerName,event,verify,context}={}){
 const org=uuid(organizationId),trustedProvider=provider(providerName);
 if(!event||typeof event!=="object"||Array.isArray(event))throw new Error("A normalized provider reservation lifecycle event is required.");
 if(typeof verify!=="function")throw new Error("A configured provider verification function is required.");
 const eventType=typeof event.eventType==="string"?event.eventType.trim().toLowerCase():"";
 const status=typeof event.status==="string"?event.status.trim().toLowerCase():"";
 if(eventType!=="reservation.status_changed"||!STATUSES.has(status))throw new Error("Only an allowlisted reservation status-change event can be recorded.");
 const eventId=identifier(event.eventId,"eventId"),reservationId=identifier(event.reservationId,"reservationId"),occurredAt=utc(event.occurredAt);
 const proof=await verify(Object.freeze({organizationId:org,provider:trustedProvider,event,context}));
 if(!proof||proof.verified!==true||!METHODS.has(proof.method))throw new Error("Provider reservation lifecycle evidence was not verified.");
 const evidence=Object.freeze({organizationId:org,provider:trustedProvider,eventId,eventType,reservationId,status,occurredAt,verificationMethod:proof.method});
 VERIFIED.add(evidence);return evidence;
}
function isVerifiedReservationLifecycleEvidence(value){return Boolean(value&&typeof value==="object"&&VERIFIED.has(value));}
module.exports={createVerifiedReservationLifecycleEvidence,isVerifiedReservationLifecycleEvidence};
