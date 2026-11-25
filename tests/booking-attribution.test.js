"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("../fixtures/booking-attribution");
const {
  DEFAULT_ATTRIBUTION_WINDOW_MS,
  hashBookingAttributionToken,
  issueBookingAttributionIntent,
  createVerifiedReservationEvidence,
  matchConfirmedReservationToBookingIntent
} = require("../booking-attribution");

async function verified(event = fixture.confirmedReservationEvent, provider = "synthetic-pms") {
  return createVerifiedReservationEvidence({
    provider,
    event,
    verify: async ({ event: candidate }) => candidate.syntheticVerifierMarker === "fixture-valid"
      ? { verified: true, method: "api_readback" }
      : { verified: false }
  });
}

test("synthetic fixture matches a provider-confirmed reservation to its originating conversation", async () => {
  assert.match(fixture.label, /^SYNTHETIC TEST DATA ONLY/);
  const evidence = await verified();
  const match = matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    verifiedEvidence: evidence,
    attributionIntent: fixture.attributionIntent
  });
  assert.equal(match.conversationId, fixture.conversationId);
  assert.equal(match.reservationId, "synthetic-reservation-001");
  assert.equal(match.provider, "synthetic-pms");
  assert.equal(match.providerEventId, "synthetic-provider-event-001");
  assert.equal(match.matchMethod, "opaque_provider_correlation");
  assert.equal(match.verificationMethod, "api_readback");
  assert.deepEqual(match.bookingValue, { amountMinor: 84000, currency: "EUR" });
  assert.equal("oneTimeToken" in match, false);
  assert.equal("guestEmail" in match, false);
  assert.equal("guestName" in match, false);
});

test("issues a one-time 256-bit token but stores only its SHA-256 hash in the intent record", () => {
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

test("requires a verifier-created evidence capability; raw provider-shaped objects cannot be matched", async () => {
  assert.throws(() => matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    verifiedEvidence: fixture.confirmedReservationEvent,
    attributionIntent: fixture.attributionIntent
  }), /provider-verified/);
  await assert.rejects(createVerifiedReservationEvidence({
    provider: "synthetic-pms",
    event: { ...fixture.confirmedReservationEvent, syntheticVerifierMarker: "invalid" },
    verify: async () => ({ verified: false, method: "api_readback" })
  }), /not verified/);
});

test("provider identity comes from trusted adapter configuration, not the event payload", async () => {
  const evidence = await verified({ ...fixture.confirmedReservationEvent, provider: "attacker-provider" });
  assert.equal(evidence.provider, "synthetic-pms");
  assert.notEqual(evidence.provider, "attacker-provider");
});

test("only confirmed reservation create/update events are eligible", async () => {
  for (const patch of [
    { status: "pending" },
    { status: "cancelled" },
    { status: "checked_in" },
    { eventType: "reservation.cancelled" },
    { eventType: "reservation.checked_in" }
  ]) {
    await assert.rejects(verified({ ...fixture.confirmedReservationEvent, ...patch }), /confirmed reservation/);
  }
});

test("reservation event time must fall inside the intent window", async () => {
  const evidenceBefore = await verified({ ...fixture.confirmedReservationEvent, occurredAt: "2026-11-25T07:59:59.000Z" });
  const evidenceAfter = await verified({ ...fixture.confirmedReservationEvent, occurredAt: "2026-11-26T08:00:00.001Z" });
  assert.equal(matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    verifiedEvidence: evidenceBefore,
    attributionIntent: fixture.attributionIntent
  }), null);
  assert.equal(matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    verifiedEvidence: evidenceAfter,
    attributionIntent: fixture.attributionIntent
  }), null);
});

test("a confirmed booking without verified price evidence is linked without inventing booking value", async () => {
  const evidence = await verified({
    ...fixture.confirmedReservationEvent,
    totalAmountMinor: null,
    currency: null
  });
  const match = matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    verifiedEvidence: evidence,
    attributionIntent: fixture.attributionIntent
  });
  assert.equal(match.conversationId, fixture.conversationId);
  assert.equal(match.bookingValue, null);
});

test("partial or invalid booking value evidence is rejected rather than silently normalised", async () => {
  for (const patch of [
    { totalAmountMinor: 84000, currency: null },
    { totalAmountMinor: 0, currency: "EUR" },
    { totalAmountMinor: 1.5, currency: "EUR" },
    { totalAmountMinor: 84000, currency: "ZZZ" }
  ]) {
    await assert.rejects(verified({ ...fixture.confirmedReservationEvent, ...patch }), /booking value/);
  }
});

test("refuses cross-tenant, consumed and revoked intent matches", async () => {
  const evidence = await verified();
  const otherOrganization = "33333333-3333-4333-8333-333333333333";
  assert.equal(matchConfirmedReservationToBookingIntent({
    organizationId: otherOrganization,
    verifiedEvidence: evidence,
    attributionIntent: fixture.attributionIntent
  }), null);
  assert.equal(matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    verifiedEvidence: evidence,
    attributionIntent: { ...fixture.attributionIntent, consumedAt: "2026-11-25T08:06:00.000Z" }
  }), null);
  assert.equal(matchConfirmedReservationToBookingIntent({
    organizationId: fixture.organizationId,
    verifiedEvidence: evidence,
    attributionIntent: { ...fixture.attributionIntent, revokedAt: "2026-11-25T08:06:00.000Z" }
  }), null);
});

test("rejects malformed identifiers, timestamps, tokens and attribution windows", () => {
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
