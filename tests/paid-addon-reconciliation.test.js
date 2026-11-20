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

test("emits a paid add-on only when a Veyra item is linked to a full-payment Receipt", () => {
  const [event] = reconcilePaidAddons(fixture());
  assert.equal(event.status, "paid_addon_verified");
  assert.equal(event.amountMinor, 12500);
  assert.equal(event.reservationId, "reservation-22");
  assert.deepEqual(event.evidence.chargedPaymentIds, ["payment-5"]);
});

test("supports a trusted paid-in-full Receipt when the provider exposes no bill total", () => {
  const result = reconcilePaidAddons(fixture({
    bills: [{ id: "bill-9", type: "Receipt", currency: "EUR", paidInFull: true }]
  }));
  assert.equal(result.length, 1);
});

test("does not infer paid revenue from an Invoice, pending payment or reservation total", () => {
  assert.equal(reconcilePaidAddons(fixture({
    bills: [{ id: "bill-9", type: "Invoice", totalAmountMinor: 12500, currency: "EUR" }]
  })).length, 0);
  assert.equal(reconcilePaidAddons(fixture({
    payments: [{ ...fixture().payments[0], status: "Pending" }]
  })).length, 0);
  assert.deepEqual(reconcilePaidAddons(fixture({
    orderItems: [], bills: [], payments: [], reservationTotalMinor: 999999
  })), []);
});

test("requires the paid add-on to have a Veyra external identifier, closed state and reservation", () => {
  assert.equal(reconcilePaidAddons(fixture({
    orderItems: [{ ...fixture().orderItems[0], externalIdentifier: "hotel-front-desk" }]
  })).length, 0);
  assert.equal(reconcilePaidAddons(fixture({
    orderItems: [{ ...fixture().orderItems[0], accountingState: "Open" }]
  })).length, 0);
  assert.equal(reconcilePaidAddons(fixture({
    orderItems: [{ ...fixture().orderItems[0], reservationId: null }]
  })).length, 0);
});

test("deducts confirmed partial and full refunds while preserving gross evidence", () => {
  const partial = reconcilePaidAddons(fixture({ adjustments: [{
    itemId: "item-101", type: "refund", status: "confirmed",
    externalReference: "refund-1", amountMinor: 2500, currency: "EUR",
    occurredAt: "2026-11-16T10:00:00.000Z"
  }] }))[0];
  assert.equal(partial.grossAmountMinor, 12500);
  assert.equal(partial.adjustmentAmountMinor, 2500);
  assert.equal(partial.amountMinor, 10000);

  const full = reconcilePaidAddons(fixture({ adjustments: [{
    itemId: "item-101", type: "chargeback", status: "confirmed",
    externalReference: "chargeback-1", amountMinor: 12500, currency: "EUR",
    occurredAt: "2026-11-16T10:00:00.000Z"
  }] }))[0];
  assert.equal(full.grossAmountMinor, 12500);
  assert.equal(full.adjustmentAmountMinor, 12500);
  assert.equal(full.amountMinor, 0);
});

test("rejects over-refunds, cross-currency adjustments and adjustments for unknown items", () => {
  assert.throws(() => reconcilePaidAddons(fixture({ adjustments: [{
    itemId: "item-101", type: "refund", status: "confirmed",
    externalReference: "refund-over", amountMinor: 13000, currency: "EUR",
    occurredAt: "2026-11-16T10:00:00.000Z"
  }] })), /cannot exceed/);

  assert.throws(() => reconcilePaidAddons(fixture({ adjustments: [{
    itemId: "item-101", type: "refund", status: "confirmed",
    externalReference: "refund-usd", amountMinor: 100, currency: "USD",
    occurredAt: "2026-11-16T10:00:00.000Z"
  }] })), /currency must match/);

  assert.throws(() => reconcilePaidAddons(fixture({ adjustments: [{
    itemId: "other-item", type: "refund", status: "confirmed",
    externalReference: "refund-unknown", amountMinor: 100, currency: "EUR",
    occurredAt: "2026-11-16T10:00:00.000Z"
  }] })), /must reference an order item/);
});

test("rejects duplicate provider identifiers and Veyra external identifiers", () => {
  assert.throws(() => reconcilePaidAddons(fixture({
    payments: [...fixture().payments, fixture().payments[0]]
  })), /duplicate identifiers/);
  assert.throws(() => reconcilePaidAddons(fixture({
    orderItems: [
      ...fixture().orderItems,
      { ...fixture().orderItems[0], id: "item-102" }
    ]
  })), /cannot identify multiple/);
});

test("keeps output limited to evidence and excludes guest PII", () => {
  const [event] = reconcilePaidAddons(fixture({
    orderItems: [{ ...fixture().orderItems[0], guestName: "Synthetic Guest", guestEmail: "guest@example.invalid" }]
  }));
  assert.equal("guestName" in event, false);
  assert.equal("guestEmail" in event, false);
});
