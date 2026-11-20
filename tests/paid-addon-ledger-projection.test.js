"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { projectPaidAddonToLedger } = require("../paid-addon-ledger-projection");

function event(overrides = {}) {
  return {
    organizationId: "synthetic-hotel-a",
    provider: "synthetic-provider",
    type: "addon_paid",
    status: "paid_addon_verified",
    externalReference: "item-101",
    sourceReference: "bill-9",
    reservationId: "reservation-22",
    grossAmountMinor: 12500,
    adjustmentAmountMinor: 2500,
    amountMinor: 10000,
    currency: "EUR",
    occurredAt: "2026-11-16T09:00:00.000Z",
    evidence: {
      billType: "Receipt",
      chargedPaymentIds: ["payment-1"],
      adjustmentReferences: ["refund-1"]
    },
    adjustments: [{
      externalReference: "refund-1",
      type: "refund",
      amountMinor: 2500,
      currency: "EUR",
      occurredAt: "2026-11-16T10:00:00.000Z"
    }],
    ...overrides
  };
}

test("projects gross add-on and confirmed refund separately without claiming Veyra attribution", () => {
  const result = projectPaidAddonToLedger(event());
  assert.equal(result.revenueEvent.amountMinor, 12500);
  assert.equal(result.revenueEvent.externalReference, "item-101");
  assert.equal(result.revenueEvent.sourceReference, "bill-9");
  assert.equal("conversationId" in result.revenueEvent, false);
  assert.equal(result.attribution, "hotel_reported_unlinked");
  assert.equal(result.adjustments[0].amount, "25.00");
  assert.equal(result.adjustments[0].originalExternalReference, "item-101");
});

test("rejects unverified events, missing tenant identity and incomplete Receipt evidence", () => {
  assert.throws(() => projectPaidAddonToLedger(event({ type: "booking_confirmed" })), /Only verified/);
  assert.throws(() => projectPaidAddonToLedger(event({ organizationId: "" })), /tenant-scoped/);
  assert.throws(() => projectPaidAddonToLedger(event({
    evidence: { billType: "Receipt", chargedPaymentIds: [], adjustmentReferences: ["refund-1"] }
  })), /Charged payment evidence/);
});

test("rejects inconsistent gross, adjustment and net values", () => {
  assert.throws(() => projectPaidAddonToLedger(event({ amountMinor: 11000 })), /reconcile exactly/);
});

test("rejects incomplete or duplicated adjustment evidence", () => {
  assert.throws(() => projectPaidAddonToLedger(event({ adjustments: [] })), /Adjustment evidence is incomplete/);
  assert.throws(() => projectPaidAddonToLedger(event({
    adjustments: [
      { externalReference: "refund-1", type: "refund", amountMinor: 1000, currency: "EUR", occurredAt: "2026-11-16T10:00:00.000Z" },
      { externalReference: "refund-1", type: "refund", amountMinor: 1500, currency: "EUR", occurredAt: "2026-11-16T10:01:00.000Z" }
    ]
  })), /Duplicate adjustment references/);
});

test("supports zero-decimal currencies", () => {
  const result = projectPaidAddonToLedger(event({
    grossAmountMinor: 1000,
    adjustmentAmountMinor: 0,
    amountMinor: 1000,
    currency: "JPY",
    evidence: { billType: "Receipt", chargedPaymentIds: ["payment-1"], adjustmentReferences: [] },
    adjustments: []
  }));
  assert.equal(result.revenueEvent.amountMinor, 1000);
  assert.deepEqual(result.adjustments, []);
});

test("requires canonical timestamps for revenue and adjustments", () => {
  assert.throws(() => projectPaidAddonToLedger(event({ occurredAt: "not-a-date" })), /canonical UTC timestamp/);
  assert.throws(() => projectPaidAddonToLedger(event({
    adjustments: [{
      externalReference: "refund-1",
      type: "refund",
      amountMinor: 2500,
      currency: "EUR",
      occurredAt: "not-a-date"
    }]
  })), /canonical UTC timestamp/);
});
