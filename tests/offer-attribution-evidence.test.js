"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  currencyDigits,
  toMinorUnits,
  normalizeSaleTimestamp,
  normalizeOfferAttributionUpdate
} = require("../offer-attribution-evidence");

function validConversion(overrides = {}) {
  return {
    status: "converted",
    amount_minor: 12345,
    currency: "EUR",
    evidence_type: "pms_record",
    evidence_source_reference: "PMS-SALE-1042",
    sale_occurred_at: new Date(Date.now() - 60_000).toISOString(),
    notes: "Checked against the hotel's record",
    ...overrides
  };
}

test("converts major-unit inputs using each currency's actual minor-unit precision", () => {
  assert.equal(toMinorUnits("125.50", "EUR"), 12550);
  assert.equal(toMinorUnits("125", "JPY"), 125);
  assert.equal(toMinorUnits("1.234", "KWD"), 1234);
  assert.equal(currencyDigits("THB"), 2);
  assert.throws(() => toMinorUnits("12.345", "EUR"), /decimal places/);
  assert.throws(() => toMinorUnits("12.1", "JPY"), /decimal places/);
});

test("requires a positive safely representable amount", () => {
  for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "not-money"]) {
    assert.throws(() => normalizeOfferAttributionUpdate(validConversion({ amount_minor: amount })));
  }
  assert.throws(() => toMinorUnits("0", "EUR"));
});

test("requires a supported ISO currency code", () => {
  for (const currency of ["", "EURO", "ABC", "12A"]) {
    assert.throws(() => normalizeOfferAttributionUpdate(validConversion({ currency })));
  }
});

test("requires a supported evidence type and an opaque source reference", () => {
  assert.throws(() => normalizeOfferAttributionUpdate(validConversion({ evidence_type: "guest_note" })));
  for (const reference of ["", "   ", "guest@example.com", "John Smith", "record\nnext", "x".repeat(181)]) {
    assert.throws(() => normalizeOfferAttributionUpdate(validConversion({ evidence_source_reference: reference })));
  }
});

test("requires an explicit timezone and a real sale calendar date", () => {
  for (const sale_occurred_at of [
    "2026-11-18",
    "2026-11-18T10:00:00",
    "2026-02-30T10:00:00Z",
    "not-a-date"
  ]) {
    assert.throws(() => normalizeOfferAttributionUpdate(validConversion({ sale_occurred_at })));
  }
});

test("normalizes offset timestamps to UTC and rejects future sale dates", () => {
  assert.equal(
    normalizeSaleTimestamp("2026-11-18T10:00:00+07:00"),
    "2026-11-18T03:00:00.000Z"
  );
  assert.throws(() => normalizeSaleTimestamp(new Date(Date.now() + 10 * 60_000).toISOString()), /future/);
});

test("accepts a hotel-attested conversion with a source reference and sale date", () => {
  const result = normalizeOfferAttributionUpdate(validConversion());
  assert.equal(result.status, "converted");
  assert.equal(result.amountMinor, 12345);
  assert.equal(result.currency, "EUR");
  assert.equal(result.evidenceType, "pms_record");
  assert.equal(result.evidenceSourceReference, "PMS-SALE-1042");
  assert.ok(result.saleOccurredAt.endsWith("Z"));
});

test("closing an enquiry clears any supplied sale and evidence fields", () => {
  const result = normalizeOfferAttributionUpdate({
    status: "not_converted",
    amount_minor: 10000,
    currency: "EUR",
    evidence_type: "invoice",
    evidence_source_reference: "SHOULD-NOT-REMAIN",
    sale_occurred_at: new Date().toISOString()
  });
  assert.equal(result.amountMinor, null);
  assert.equal(result.currency, null);
  assert.equal(result.evidenceType, null);
  assert.equal(result.evidenceSourceReference, "");
  assert.equal(result.saleOccurredAt, null);
});
