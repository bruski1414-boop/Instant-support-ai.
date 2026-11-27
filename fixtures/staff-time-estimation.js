"use strict";

const { createHotelStaffTimeBaseline } = require("../staff-time-estimation");

const label = "SYNTHETIC TEST DATA ONLY — no real hotel, employee, conversation or guest records.";
const organizationId = "11111111-1111-4111-8111-111111111111";
const attestedBy = "33333333-3333-4333-8333-333333333333";
const baseline = createHotelStaffTimeBaseline({
  baselineId: "44444444-4444-4444-8444-444444444444",
  organizationId,
  category: "dining",
  medianActiveMinutes: 7,
  sampleCount: 24,
  sourceType: "historical_work_log",
  evidenceReference: "SYNTHETIC-DINING-WORKLOG-2026-10",
  sampleWindowStart: "2026-10-01T00:00:00.000Z",
  sampleWindowEnd: "2026-10-31T23:59:59.999Z",
  attestedBy,
  attestedAt: "2026-11-01T00:00:00.000Z",
  reviewDueAt: "2026-12-01T00:00:00.000Z"
});

const resolutionEvents = Object.freeze([
  Object.freeze({
    organizationId,
    conversationId: "55555555-5555-4555-8555-555555555555",
    resolutionEventId: "synthetic-resolution-001",
    category: "dining",
    resolvedAt: "2026-11-01T00:00:00.000Z",
    guestConfirmedResolved: true,
    staffTouchCount: 0,
    escalationCount: 0
  }),
  Object.freeze({
    organizationId,
    conversationId: "55555555-5555-4555-8555-555555555555",
    resolutionEventId: "synthetic-resolution-002",
    category: "dining",
    resolvedAt: "2026-11-02T10:00:00.000Z",
    guestConfirmedResolved: true,
    staffTouchCount: 0,
    escalationCount: 0
  }),
  Object.freeze({
    organizationId,
    conversationId: "66666666-6666-4666-8666-666666666666",
    resolutionEventId: "synthetic-resolution-003",
    category: "dining",
    resolvedAt: "2026-11-29T23:59:59.999Z",
    guestConfirmedResolved: true,
    staffTouchCount: 0,
    escalationCount: 0
  }),
  Object.freeze({
    organizationId,
    conversationId: "77777777-7777-4777-8777-777777777777",
    resolutionEventId: "synthetic-resolution-004",
    category: "dining",
    resolvedAt: "2026-11-30T00:00:00.000Z",
    guestConfirmedResolved: true,
    staffTouchCount: 0,
    escalationCount: 0
  })
]);

module.exports = { label, organizationId, attestedBy, baseline, resolutionEvents };
