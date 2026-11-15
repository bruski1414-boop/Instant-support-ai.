"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("../fixtures/booking-attribution");
const {
  DEFAULT_ATTRIBUTION_WINDOW_MS,
  hashBookingAttributionToken,
  issueBookingAttributionIntent,
  matchConfirmedReservationToBookingIntent
} = require("../booking-attribution");

test("synthetic fixture matches a confirmed reservation to its originating conversation", () => {
  assert.match(fixture.label, /^SYNTHETIC TEST DATA/);
  const match = matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    reservationEvent: fixture.confirmedReservationEvent,
    attributionIntent: fixture.attributionIntent
  });
  assert.equal(match.conversationId, fixture.conversationId);
  assert.equal(match.reservationId, "synthetic-reservation-001");
  assert.equal(match.provider, "synthetic-pms");
  assert.equal(match.providerEventId, "synthetic-provider-event-001");
  assert.equal(match.matchMethod, "opaque_provider_correlation");
  assert.deepEqual(match.bookingValue, { amountMinor: 84000, currency: "EUR" });
  assert.equal("oneTimeToken" in match, false);
  assert.equal("guestEmail" in match, false);
});

test("issues a one-time token but stores only its SHA-256 hash in the intent record", () => {
  const issued = issueBookingAttributionIntent({
    organizationId: fixture.organizationId,
    conversationId: fixture.conversationId,
    issuedAt: "2026-11-15T10:00:00.000Z",
    ttlMs: 24 * 60 * 60 * 1000,
    tokenFactory: () => fixture.oneTimeToken
  });
  assert.equal(issued.oneTimeToken, fixture.oneTimeToken);
  assert.equal(issued.record.tokenHash, hashBookingAttributionToken(fixture.oneTimeToken));
  assert.equal(issued.record.expiresAt, "2026-11-16T10:00:00.000Z");
  assert.equal("oneTimeToken" in issued.record, false);
  assert.equal(DEFAULT_ATTRIBUTION_WINDOW_MS, 30 * 24 * 60 * 60 * 1000);
});

test("refuses cross-tenant, mismatched-token and consumed-intent matches", () => {
  const otherOrganization = "33333333-3333-4333-8333-333333333333";
  assert.equal(matchConfirmedReservationToBookingIntent({
    organizationId: otherOrganization,
    reservationEvent: fixture.confirmedReservationEvent,
    attributionIntent: fixture.attributionIntent
  }), null);
  assert.equal(matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    reservationEvent: { ...fixture.confirmedReservationEvent, attributionToken: "E".repeat(43) },
    attributionIntent: fixture.attributionIntent
  }), null);
  assert.equal(matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    reservationEvent: fixture.confirmedReservationEvent,
    attributionIntent: { ...fixture.attributionIntent, consumedAt: "2026-11-15T10:01:00.000Z" }
  }), null);
});

test("only confirmed reservation create/update events can be matched", () => {
  for (const patch of [
    { status: "pending" },
    { status: "cancelled" },
    { status: "checked_in" },
    { eventType: "reservation.cancelled" },
    { eventType: "reservation.checked_in" }
  ]) {
    assert.equal(matchConfirmedReservationToBookingIntent({
      organizationId: fixture.organizationId,
      reservationEvent: { ...fixture.confirmedReservationEvent, ...patch },
      attributionIntent: fixture.attributionIntent
    }), null);
  }
});

test("reservation event time must fall inside the attribution window", () => {
  for (const occurredAt of ["2026-11-14T09:59:59.000Z", "2026-12-14T10:00:00.001Z"]) {
    assert.equal(matchConfirmedReservationToBookingIntent({
      organizationId: fixture.organizationId,
      reservationEvent: { ...fixture.confirmedReservationEvent, occurredAt },
      attributionIntent: fixture.attributionIntent
    }), null);
  }
});

test("a confirmed booking without a valid source amount is linked without inventing booking value", () => {
  const match = matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    reservationEvent: { ...fixture.confirmedReservationEvent, totalAmountMinor: null, currency: null },
    attributionIntent: fixture.attributionIntent
  });
  assert.equal(match.conversationId, fixture.conversationId);
  assert.equal(match.bookingValue, null);
});

test("rejects invalid identifiers, token shapes and attribution windows", () => {
  assert.throws(() => issueBookingAttributionIntent({
    organizationId: "not-a-uuid",
    conversationId: fixture.conversationId
  }), /organizationId/);
  assert.throws(() => issueBookingAttributionIntent({
    organizationId: fixture.organizationId,
    conversationId: fixture.conversationId,
    ttlMs: 31 * 24 * 60 * 60 * 1000
  }), /ttlMs/);
  assert.throws(() => hashBookingAttributionToken("short"), /token/);
  assert.throws(() => hashBookingAttributionToken("A".repeat(42) + "B"), /canonical 256-bit/);
  assert.throws(() => issueBookingAttributionIntent({
    organizationId: fixture.organizationId,
    conversationId: fixture.conversationId,
    issuedAt: "2026-02-30T10:00:00.000Z"
  }), /real UTC calendar timestamp/);
});
