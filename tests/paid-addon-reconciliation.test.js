"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcilePaidAddons } = require("../paid-addon-reconciliation");

function fixture(overrides = {}) {
  return {
    organizationId: "hotel-demo-tenant-a",
    provider: "synthetic-mews-adapter",
    orderItems: [{
      id: "item-101",
      externalIdentifier: "veyra-addon:upgrade-101",
      reservationId: "reservation-22",
      billId: "bill-9",
      accountingState: "Closed",
      amountMinor: 12500,
      currency: "EUR"
    }],
    bills: [{ id: "bill-9", type: "Receipt", totalAmountMinor: 12500, currency: "EUR" }],
    payments: [{
      id: "payment-5",
      billId: "bill-9",
      status: "Charged",
      amountMinor: 12500,
      currency: "EUR",
      occurredAt: "2026-11-16T09:00:00.000Z"
    }],
    adjustments: [],
    ...overrides
  };
}

test("attributes a Veyra-created add-on only when its Receipt is fully covered by Charged payments", () => {
  const [event] = reconcilePaidAddons(fixture());
  assert.equal(event.type, "addon_paid");
  assert.equal(event.status, "paid_addon_verified");
  assert.equal(event.amountMinor, 12500);
  assert.equal(event.currency, "EUR");
  assert.equal(event.reservationId, "reservation-22");
  assert.deepEqual(event.evidence.chargedPaymentIds, ["payment-5"]);
});

test("does not treat a closed item on an Invoice as paid revenue", () => {
  const result = reconcilePaidAddons(fixture({ bills: [{ id: "bill-9", type: "Invoice", totalAmountMinor: 12500, currency: "EUR" }] }));
  assert.equal(result.length, 0);
});

test("does not treat pending or failed payments as paid revenue", () => {
  const result = reconcilePaidAddons(fixture({ payments: [{ ...fixture().payments[0], status: "Pending" }] }));
  assert.equal(result.length, 0);
});

test("requires charged payments to cover the complete receipt", () => {
  const result = reconcilePaidAddons(fixture({ payments: [{ ...fixture().payments[0], amountMinor: 5000 }] }));
  assert.equal(result.length, 0);
});

test("ignores ordinary hotel order items without a Veyra external identifier", () => {
  const result = reconcilePaidAddons(fixture({ orderItems: [{ ...fixture().orderItems[0], externalIdentifier: "hotel-front-desk" }] }));
  assert.equal(result.length, 0);
});

test("requires a Veyra-created item to be linked to a reservation and a closed bill item", () => {
  const noReservation = fixture({ orderItems: [{ ...fixture().orderItems[0], reservationId: null }] });
  assert.equal(reconcilePaidAddons(noReservation).length, 0);
  const notClosed = fixture({ orderItems: [{ ...fixture().orderItems[0], accountingState: "Open" }] });
  assert.equal(reconcilePaidAddons(notClosed).length, 0);
});

test("deducts confirmed partial refunds and chargebacks without overstating net add-on revenue", () => {
  const [event] = reconcilePaidAddons(fixture({ adjustments: [{
    itemId: "item-101", type: "refund", status: "confirmed",
    externalReference: "refund-44", amountMinor: 2500, currency: "EUR",
    occurredAt: "2026-11-16T10:00:00.000Z"
  }] }));
  assert.equal(event.grossAmountMinor, 12500);
  assert.equal(event.adjustmentAmountMinor, 2500);
  assert.equal(event.amountMinor, 10000);
});

test("preserves a fully refunded add-on so its gross receipt and full adjustment net to zero", () => {
  const result = reconcilePaidAddons(fixture({ adjustments: [{
    itemId: "item-101", type: "chargeback", status: "confirmed",
    externalReference: "chargeback-44", amountMinor: 12500, currency: "EUR",
    occurredAt: "2026-11-16T10:00:00.000Z"
  }] }));
  assert.equal(result.length, 1);
  assert.equal(result[0].grossAmountMinor, 12500);
  assert.equal(result[0].adjustmentAmountMinor, 12500);
  assert.equal(result[0].amountMinor, 0);
  assert.deepEqual(result[0].evidence.adjustmentReferences, ["chargeback-44"]);
});

test("rejects adjustments exceeding the original paid add-on", () => {
  assert.throws(() => reconcilePaidAddons(fixture({ adjustments: [{
    itemId: "item-101", type: "refund", status: "confirmed",
    externalReference: "refund-45", amountMinor: 13000, currency: "EUR",
    occurredAt: "2026-11-16T10:00:00.000Z"
  }] })), /cannot exceed/);
});

test("rejects cross-currency adjustments and duplicate source identifiers", () => {
  assert.throws(() => reconcilePaidAddons(fixture({ adjustments: [{
    itemId: "item-101", type: "refund", status: "confirmed",
    externalReference: "refund-46", amountMinor: 100, currency: "USD",
    occurredAt: "2026-11-16T10:00:00.000Z"
  }] })), /currency must match/);
  assert.throws(() => reconcilePaidAddons(fixture({ payments: [...fixture().payments, fixture().payments[0]] })), /duplicate identifiers/);
});

test("does not infer revenue from a reservation total or booking confirmation alone", () => {
  const result = reconcilePaidAddons(fixture({
    orderItems: [],
    bills: [],
    payments: [],
    reservationTotalMinor: 999999
  }));
  assert.deepEqual(result, []);
});

test("keeps output limited to reconciliation evidence and excludes guest information", () => {
  const input = fixture({ orderItems: [{ ...fixture().orderItems[0], guestName: "Synthetic Guest", guestEmail: "guest@example.invalid" }] });
  const [event] = reconcilePaidAddons(input);
  assert.equal("guestName" in event, false);
  assert.equal("guestEmail" in event, false);
});

test("accepts an explicit provider-attested paid-in-full Receipt when the provider exposes no bill total", () => {
  const result = reconcilePaidAddons(fixture({
    bills: [{ id: "bill-9", type: "Receipt", currency: "EUR", paidInFull: true }]
  }));
  assert.equal(result.length, 1);
  assert.equal(result[0].amountMinor, 12500);
  assert.equal(result[0].evidence.billType, "Receipt");
});

test("does not infer paid-in-full from a Receipt label without a total or trusted paidInFull evidence", () => {
  const result = reconcilePaidAddons(fixture({
    bills: [{ id: "bill-9", type: "Receipt", currency: "EUR" }]
  }));
  assert.equal(result.length, 0);
});
