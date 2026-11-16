"use strict";

// SYNTHETIC TEST FIXTURE ONLY. No real hotel, guest, booking or provider data.
const { hashBookingAttributionToken } = require("../booking-attribution");

const oneTimeToken = "A".repeat(43);
const organizationId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

module.exports = Object.freeze({
  label: "SYNTHETIC TEST DATA — not a real hotel or guest",
  oneTimeToken,
  organizationId,
  conversationId,
  attributionIntent: Object.freeze({
    schemaVersion: 1,
    organizationId,
    conversationId,
    tokenHash: hashBookingAttributionToken(oneTimeToken),
    issuedAt: "2026-11-14T10:00:00.000Z",
    expiresAt: "2026-12-14T10:00:00.000Z",
    consumedAt: null
  }),
  confirmedReservationEvent: Object.freeze({
    schemaVersion: 1,
    provider: "synthetic-pms",
    eventId: "synthetic-provider-event-001",
    eventType: "reservation.created",
    occurredAt: "2026-11-15T10:00:00.000Z",
    reservationId: "synthetic-reservation-001",
    status: "confirmed",
    arrivalDate: "2026-12-01",
    departureDate: "2026-12-04",
    totalAmountMinor: 84000,
    currency: "EUR",
    attributionToken: oneTimeToken
  })
});
