const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRevenueEvent, toMinorUnits } = require("../revenue-attribution");

const validEvent = {
  type: "booking_confirmed",
  externalReference: "PMS-BOOKING-1042",
  sourceReference: "Hotel manager report, 2026-11-13",
  amountMinor: 250000,
  currency: "eur",
  occurredAt: "2026-11-13T10:30:00Z"
};

test("normalizes a hotel-attested confirmed booking into minor currency units", () => {
  const event = normalizeRevenueEvent(validEvent);
  assert.equal(event.currency, "EUR");
  assert.equal(event.amountMinor, 250000);
  assert.equal(event.attributionStatus, "hotel_reported_unlinked");
  assert.equal(event.occurredAt, "2026-11-13T10:30:00.000Z");
});

test("accepts paid add-ons as a distinct revenue event", () => {
  assert.equal(normalizeRevenueEvent({ ...validEvent, type: "addon_paid" }).type, "addon_paid");
});

test("rejects conversations, estimates and unconfirmed bookings as revenue", () => {
  for (const type of ["conversation", "estimated_revenue", "booking_enquiry", "booking_pending"]) {
    assert.throws(() => normalizeRevenueEvent({ ...validEvent, type }));
  }
});

test("requires a traceable hotel source and external reference", () => {
  assert.throws(() => normalizeRevenueEvent({ ...validEvent, sourceReference: "" }));
  assert.throws(() => normalizeRevenueEvent({ ...validEvent, externalReference: "" }));
});

test("rejects floating point, zero and negative amounts", () => {
  for (const amountMinor of [0, -1, 10.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeRevenueEvent({ ...validEvent, amountMinor }));
  }
});

test("requires a valid three-letter currency and event date", () => {
  assert.throws(() => normalizeRevenueEvent({ ...validEvent, currency: "EURO" }));
  assert.throws(() => normalizeRevenueEvent({ ...validEvent, occurredAt: "not-a-date" }));
});

test("converts decimal amounts using the currency's minor-unit precision", () => {
  assert.equal(toMinorUnits("125.50", "EUR"), 12550);
  assert.equal(toMinorUnits("125", "JPY"), 125);
  assert.throws(() => toMinorUnits("12.345", "EUR"));
});

test("a Veyra conversation link is explicitly marked as hotel-attested attribution", () => {
  const event = normalizeRevenueEvent({
    ...validEvent,
    conversationId: "123e4567-e89b-42d3-a456-426614174000"
  });
  assert.equal(event.attributionStatus, "veyra_linked_hotel_attested");
  assert.equal(event.conversationId, "123e4567-e89b-42d3-a456-426614174000");
});

test("a malformed Veyra conversation link is rejected", () => {
  assert.throws(() => normalizeRevenueEvent({ ...validEvent, conversationId: "not-a-uuid" }));
});
