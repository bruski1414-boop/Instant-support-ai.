"use strict";

const { issueBookingAttributionIntent } = require("../booking-attribution");

const label = "SYNTHETIC TEST DATA ONLY — no real hotel, reservation, payment or guest records.";
const organizationId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const oneTimeToken = Buffer.alloc(32, 7).toString("base64url");
const issued = issueBookingAttributionIntent({
  organizationId,
  conversationId,
  issuedAt: "2026-11-25T08:00:00.000Z",
  ttlMs: 24 * 60 * 60 * 1000,
  tokenFactory: () => oneTimeToken
});

const confirmedReservationEvent = Object.freeze({
  eventId: "synthetic-provider-event-001",
  eventType: "reservation.created",
  occurredAt: "2026-11-25T08:05:00.000Z",
  reservationId: "synthetic-reservation-001",
  status: "confirmed",
  attributionToken: oneTimeToken,
  totalAmountMinor: 84000,
  currency: "EUR",
  syntheticVerifierMarker: "fixture-valid",
  guestEmail: "must-not-be-persisted@example.invalid",
  guestName: "Synthetic Guest"
});

module.exports = {
  label,
  organizationId,
  conversationId,
  oneTimeToken,
  attributionIntent: issued.record,
  confirmedReservationEvent
};
