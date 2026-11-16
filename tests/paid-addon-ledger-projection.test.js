"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { projectPaidAddonToLedger } = require("../paid-addon-ledger-projection");

function event(overrides = {}) {
 return {
  organizationId:"synthetic-hotel-a", provider:"synthetic-provider", type:"addon_paid",
  status:"paid_addon_verified", externalReference:"item-101", sourceReference:"bill-9",
  reservationId:"reservation-22", grossAmountMinor:12500, adjustmentAmountMinor:2500,
  amountMinor:10000, currency:"EUR", occurredAt:"2026-11-16T09:00:00.000Z",
  evidence:{billType:"Receipt",chargedPaymentIds:["payment-1"],adjustmentReferences:["refund-1"]},
  adjustments:[{externalReference:"refund-1",type:"refund",amountMinor:2500,currency:"EUR",occurredAt:"2026-11-16T10:00:00.000Z"}],
  ...overrides
 };
}

test("projects gross add-on and separate confirmed adjustment into existing ledger shapes",()=>{
 const result=projectPaidAddonToLedger(event());
 assert.equal(result.revenueEvent.type,"addon_paid");
 assert.equal(result.revenueEvent.amountMinor,12500);
 assert.equal(result.revenueEvent.externalReference,"item-101");
 assert.equal(result.revenueEvent.sourceReference,"bill-9");
 assert.equal("conversationId" in result.revenueEvent,false);
 assert.equal(result.attribution,"hotel_reported_unlinked");
 assert.deepEqual(result.adjustments,[{
  type:"refund",originalType:"addon_paid",externalReference:"refund-1",
  originalExternalReference:"item-101",sourceReference:"refund-1",
  amount:"25.00",currency:"EUR",occurredAt:"2026-11-16T10:00:00.000Z"
 }]);
});

test("rejects booking-only or unverified records",()=>{
 assert.throws(()=>projectPaidAddonToLedger(event({type:"booking_confirmed"})),/Only verified/);
 assert.throws(()=>projectPaidAddonToLedger(event({status:"hotel_reported_unlinked"})),/Only verified/);
});

test("rejects inconsistent gross, adjustment and net values",()=>{
 assert.throws(()=>projectPaidAddonToLedger(event({amountMinor:11000})),/reconcile exactly/);
});

test("rejects incomplete payment evidence and missing tenant identity",()=>{
 assert.throws(()=>projectPaidAddonToLedger(event({evidence:{billType:"Receipt",chargedPaymentIds:[],adjustmentReferences:["refund-1"]}})),/Full-payment receipt/);
 assert.throws(()=>projectPaidAddonToLedger(event({organizationId:""})),/tenant-scoped/);
});

test("rejects adjustments that do not match provider adjustment references",()=>{
 assert.throws(()=>projectPaidAddonToLedger(event({adjustments:[]})),/Adjustment evidence is incomplete/);
});

test("supports currencies with zero decimal places",()=>{
 const input=event({
  grossAmountMinor:1000,adjustmentAmountMinor:0,amountMinor:1000,currency:"JPY",
  evidence:{billType:"Receipt",chargedPaymentIds:["p-1"],adjustmentReferences:[]},adjustments:[]
 });
 assert.equal(projectPaidAddonToLedger(input).revenueEvent.amountMinor,1000);
});
