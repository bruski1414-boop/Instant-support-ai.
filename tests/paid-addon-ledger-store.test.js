"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePaidAddonLedgerEvent } = require("../paid-addon-ledger-store");

const organizationId = "11111111-1111-4111-8111-111111111111";

function event(overrides = {}) {
  const base = {
    organizationId,
    provider: "mews",
    type: "addon_paid",
    status: "paid_addon_verified",
    externalReference: "mews-item-101",
    sourceReference: "mews-bill-9",
    reservationId: "mews-reservation-22",
    externalIdentifier: "veyra-addon:upgrade-101",
    grossAmountMinor: 12500,
    adjustmentAmountMinor: 0,
    amountMinor: 12500,
    currency: "EUR",
    occurredAt: "2026-11-20T09:00:00.000Z",
    adjustments: [],
    evidence: {
      billType: "Receipt",
      billId: "mews-bill-9",
      chargedPaymentIds: ["mews-payment-5"],
      adjustmentReferences: []
    }
  };
  return { ...base, ...overrides };
}

test("normalizes provider evidence into an unlinked allowlisted ledger record", () => {
  const normalized = normalizePaidAddonLedgerEvent(event({
    guestName: "Synthetic Guest must not persist",
    notes: "Synthetic private note must not persist",
    evidence: {
      ...event().evidence,
      guestName: "Synthetic Guest must not persist"
    }
  }), organizationId);
  assert.equal(normalized.attributionStatus, "hotel_reported_unlinked");
  assert.equal(normalized.grossAmountMinor, 12500);
  assert.equal(normalized.amountMinor, 12500);
  assert.equal(normalized.currency, "EUR");
  assert.equal(normalized.evidence.billType, "Receipt");
  assert.equal("conversationId" in normalized, false);
  assert.equal(JSON.stringify(normalized).includes("Synthetic Guest"), false);
  assert.equal(JSON.stringify(normalized).includes("private note"), false);
});

test("rejects cross-tenant, unsupported provider and unverified event types", () => {
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ organizationId: "22222222-2222-4222-8222-222222222222" }), organizationId), /authenticated tenant/);
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ provider: "other" }), organizationId), /Only reconciled Mews/);
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ status: "hotel_reported" }), organizationId), /Only reconciled Mews/);
});

test("does not infer conversation attribution and rejects unallocated adjustments", () => {
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ conversationId: "conversation-1" }), organizationId), /remain unlinked/);
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ adjustmentAmountMinor: 100, amountMinor: 12400 }), organizationId), /item-allocation proof/);
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ adjustments: [{ type: "refund" }] }), organizationId), /item-allocation proof/);
});

test("requires exact currency, positive integer minor units and canonical UTC", () => {
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ currency: "eur" }), organizationId), /uppercase ISO/);
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ grossAmountMinor: 0, amountMinor: 0 }), organizationId), /positive integer/);
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ occurredAt: "2026-11-20T09:00:00+01:00" }), organizationId), /canonical UTC/);
});

test("requires a closed Receipt and unique linked Charged payment evidence", () => {
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ evidence: { billType: "Invoice", billId: "mews-bill-9", chargedPaymentIds: ["mews-payment-5"], adjustmentReferences: [] } }), organizationId), /closed Receipt/);
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ evidence: { billType: "Receipt", billId: "mews-bill-9", chargedPaymentIds: [], adjustmentReferences: [] } }), organizationId), /closed Receipt/);
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ evidence: { billType: "Receipt", billId: "mews-bill-9", chargedPaymentIds: ["same", "same"], adjustmentReferences: [] } }), organizationId), /must be unique/);
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ evidence: { billType: "Receipt", billId: "different-bill", chargedPaymentIds: ["mews-payment-5"], adjustmentReferences: [] } }), organizationId), /closed Receipt/);
});

test("keeps all provider identifiers opaque and rejects malformed external identifiers", () => {
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ externalIdentifier: "hotel-note:guest@example.test" }), organizationId), /Veyra-issued/);
  assert.throws(() => normalizePaidAddonLedgerEvent(event({ externalReference: "contains spaces" }), organizationId), /valid opaque identifier/);
});
