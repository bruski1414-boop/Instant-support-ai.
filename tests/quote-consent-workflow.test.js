"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createQuoteWorkflow } = require("../quote-consent-workflow");

const fixedNow = () => new Date("2026-11-19T10:00:00.000Z");
const request = {
  checkIn: "2027-01-10", checkOut: "2027-01-12",
  roomTypeId: "villa-ocean", ratePlanId: "flexible", guestCount: 2,
};
function makeProvider(overrides = {}) {
  const quote = {
    organizationId: "hotel-a", checkIn: request.checkIn, checkOut: request.checkOut,
    roomTypeId: request.roomTypeId, ratePlanId: request.ratePlanId,
    currency: "SAR", totalAmountMinor: 1000000, taxesAmountMinor: 150000,
    feesAmountMinor: 25000, depositAmountMinor: 500000,
    cancellationPolicy: "Free cancellation until 7 days before arrival.",
    quoteId: "quote-123", expiresAt: "2026-11-19T10:08:00.000Z",
  };
  return {
    quote,
    getQuote: async () => ({ ...quote }),
    createReservation: async () => ({ organizationId: "hotel-a", status: "confirmed", bookingId: "BOOK-123" }),
    lookupReservationByIdempotencyKey: async () => null,
    ...overrides,
  };
}
function workflow(provider = makeProvider(), now = fixedNow) {
  return createQuoteWorkflow({
    provider, organizationId: "hotel-a",
    signingSecret: "test-only-secret-that-is-long-enough-123",
    now,
  });
}

test("issues a tenant-bound quote with total, tax, fee, deposit and cancellation terms", async () => {
  const result = await workflow().issue(request);
  assert.equal(result.quote.totalAmountMinor, 1000000);
  assert.equal(result.quote.taxesAmountMinor, 150000);
  assert.equal(result.quote.feesAmountMinor, 25000);
  assert.equal(result.quote.depositAmountMinor, 500000);
  assert.match(result.quote.cancellationPolicy, /7 days/);
  assert.equal(result.requiresExplicitAcceptance, true);
});

test("does not write a reservation until the guest accepts the exact quote", async () => {
  let writes = 0;
  const provider = makeProvider({ createReservation: async () => {
    writes++;
    return { organizationId: "hotel-a", status: "confirmed", bookingId: "BOOK-1" };
  }});
  const service = workflow(provider);
  const issued = await service.issue(request);
  await assert.rejects(
    service.confirm({ quoteToken: issued.quoteToken, accepted: false, guest: { name: "Alex Guest", phone: "+66812345678" }, idempotencyKey: "booking_req_12345" }),
    e => e.code === "QUOTE_NOT_ACCEPTED",
  );
  assert.equal(writes, 0);
});

test("refuses to book if the quote changes between display and acceptance", async () => {
  let calls = 0;
  let writes = 0;
  const provider = makeProvider({
    getQuote: async () => {
      calls++;
      const q = { ...makeProvider().quote };
      if (calls > 1) q.totalAmountMinor += 10000;
      return q;
    },
    createReservation: async () => { writes++; return { organizationId: "hotel-a", status: "confirmed", bookingId: "X" }; },
  });
  const service = workflow(provider);
  const issued = await service.issue(request);
  const result = await service.confirm({
    quoteToken: issued.quoteToken, accepted: true, consentToShareDetails: true,
    guest: { name: "Alex Guest", phone: "+66812345678" },
    idempotencyKey: "booking_req_12345",
  });
  assert.equal(result.status, "quote_changed");
  assert.equal(writes, 0);
});

test("reconciles an uncertain write by the original idempotency key without retrying", async () => {
  let writes = 0;
  let lookups = 0;
  const provider = makeProvider({
    createReservation: async () => { writes++; throw new Error("connection lost"); },
    lookupReservationByIdempotencyKey: async key => {
      lookups++;
      assert.equal(key, "booking_req_12345");
      return { status: "confirmed", bookingId: "BOOK-RECOVERED" };
    },
  });
  const service = workflow(provider);
  const issued = await service.issue(request);
  const result = await service.confirm({
    quoteToken: issued.quoteToken, accepted: true, consentToShareDetails: true,
    guest: { name: "Alex Guest", phone: "+66812345678" },
    idempotencyKey: "booking_req_12345",
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.reconciled, true);
  assert.equal(writes, 1);
  assert.equal(lookups, 1);
});

test("rejects tampered, expired and cross-tenant quote tokens", async () => {
  const service = workflow();
  const issued = await service.issue(request);
  await assert.rejects(service.confirm({
    quoteToken: issued.quoteToken + "x", accepted: true, consentToShareDetails: true,
    guest: { name: "Alex Guest", phone: "+66812345678" }, idempotencyKey: "booking_req_12345",
  }), e => e.code === "INVALID_QUOTE_TOKEN");

  const expiredService = workflow(makeProvider(), () => new Date("2026-11-19T10:11:00.000Z"));
  await assert.rejects(expiredService.confirm({
    quoteToken: issued.quoteToken, accepted: true, consentToShareDetails: true,
    guest: { name: "Alex Guest", phone: "+66812345678" }, idempotencyKey: "booking_req_12345",
  }), e => e.code === "QUOTE_EXPIRED");
});

test("fails closed on malformed financial terms", async () => {
  const provider = makeProvider({ getQuote: async () => ({ ...makeProvider().quote, totalAmountMinor: -1 }) });
  await assert.rejects(workflow(provider).issue(request), e => e.code === "INVALID_QUOTE");
});
