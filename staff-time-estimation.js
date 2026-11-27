"use strict";

const { randomUUID, createHash } = require("node:crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const CATEGORIES = new Set([
  "bookings_stays", "dining", "spa_facilities", "transport",
  "rooms", "policies_payments", "other_questions"
]);
const BASELINE_SOURCES = new Set(["historical_work_log", "time_study"]);
const VERIFIED_BASELINES = new WeakSet();
const VERIFIED_RESOLUTIONS = new WeakSet();

function requiredUuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(field + " must be a valid UUID.");
  return value.toLowerCase();
}

function requiredOpaqueId(value, field) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value.trim()) || /^https?:/i.test(value.trim()) || !/[0-9._:-]/.test(value.trim())) {
    throw new Error(field + " must be an opaque, non-URL reference.");
  }
  return value.trim();
}

function requiredUtc(value, field) {
  if (typeof value !== "string" || !UTC.test(value)) throw new Error(field + " must be an ISO-8601 UTC timestamp.");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(field + " must be a valid timestamp.");
  const normalized = value.includes(".")
    ? value.replace(/(\.\d{1,2})Z$/, part => part.slice(0, -1).padEnd(4, "0") + "Z")
    : value.replace(/Z$/, ".000Z");
  const canonical = new Date(milliseconds).toISOString();
  if (canonical !== normalized) throw new Error(field + " must be a real UTC calendar timestamp.");
  return canonical;
}

function requiredCategory(value) {
  if (typeof value !== "string" || !CATEGORIES.has(value)) throw new Error("A supported intent category is required.");
  return value;
}

function createHotelStaffTimeBaseline(input = {}) {
  const organizationId = requiredUuid(input.organizationId, "organizationId");
  const baselineId = requiredUuid(input.baselineId || randomUUID(), "baselineId");
  const attestedBy = requiredUuid(input.attestedBy, "attestedBy");
  const category = requiredCategory(input.category);
  const medianActiveMinutes = input.medianActiveMinutes;
  const sampleCount = input.sampleCount;

  if (!Number.isSafeInteger(medianActiveMinutes) || medianActiveMinutes < 1 || medianActiveMinutes > 480) {
    throw new Error("medianActiveMinutes must be an integer from 1 to 480.");
  }
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 1000000) {
    throw new Error("sampleCount must be a positive, safe integer.");
  }
  if (!BASELINE_SOURCES.has(input.sourceType)) {
    throw new Error("sourceType must be historical_work_log or time_study.");
  }

  const evidenceReference = requiredOpaqueId(input.evidenceReference, "evidenceReference");
  const evidenceReferenceHash = createHash("sha256").update(evidenceReference).digest("hex");
  const sampleWindowStart = requiredUtc(input.sampleWindowStart, "sampleWindowStart");
  const sampleWindowEnd = requiredUtc(input.sampleWindowEnd, "sampleWindowEnd");
  const attestedAt = requiredUtc(input.attestedAt, "attestedAt");
  const reviewDueAt = requiredUtc(input.reviewDueAt, "reviewDueAt");

  if (Date.parse(sampleWindowStart) >= Date.parse(sampleWindowEnd)) throw new Error("The baseline sample window must have a positive duration.");
  if (Date.parse(sampleWindowEnd) > Date.parse(attestedAt)) throw new Error("The baseline sample window must end on or before hotel attestation.");
  if (Date.parse(reviewDueAt) <= Date.parse(attestedAt)) throw new Error("reviewDueAt must be later than attestedAt.");

  const baseline = Object.freeze({
    baselineId, organizationId, category, medianActiveMinutes, sampleCount,
    sourceType: input.sourceType, evidenceReferenceHash, sampleWindowStart,
    sampleWindowEnd, attestedBy, attestedAt, reviewDueAt,
    evidenceStatus: "hotel_attested",
    methodology: "median_active_handling_minutes"
  });
  VERIFIED_BASELINES.add(baseline);
  return baseline;
}

async function createVerifiedAiResolutionEvidence(input = {}) {
  const organizationId = requiredUuid(input.organizationId, "organizationId");
  const conversationId = requiredUuid(input.conversationId, "conversationId");
  const resolutionEventId = requiredOpaqueId(input.resolutionEventId, "resolutionEventId");
  const category = requiredCategory(input.category);
  const resolvedAt = requiredUtc(input.resolvedAt, "resolvedAt");

  if (input.guestConfirmedResolved !== true) throw new Error("An explicit guest-confirmed-resolved signal is required.");
  if (input.staffTouchCount !== 0 || input.escalationCount !== 0) {
    throw new Error("Only conversations with no recorded staff touch or escalation are eligible.");
  }
  if (typeof input.verify !== "function") throw new Error("A trusted internal event-chain verifier is required.");

  const decision = await input.verify(Object.freeze({
    organizationId, conversationId, resolutionEventId, category, resolvedAt,
    guestConfirmedResolved: true, staffTouchCount: 0, escalationCount: 0
  }));
  if (!decision || decision.verified !== true || decision.method !== "internal_event_chain") {
    throw new Error("The internal resolution event chain could not be verified.");
  }

  const evidence = Object.freeze({
    organizationId, conversationId, resolutionEventId, category, resolvedAt,
    evidenceMethod: "guest_confirmed_resolution_without_staff_touch"
  });
  VERIFIED_RESOLUTIONS.add(evidence);
  return evidence;
}

function estimatePotentialStaffTimeAvoided({ baseline, resolutionEvidence, windowStart, windowEnd } = {}) {
  if (!VERIFIED_BASELINES.has(baseline)) throw new Error("A hotel-attested staff-time baseline created by this module is required.");
  if (!VERIFIED_RESOLUTIONS.has(resolutionEvidence)) throw new Error("Verified guest-resolution evidence created by a trusted internal verifier is required.");
  const start = requiredUtc(windowStart, "windowStart");
  const end = requiredUtc(windowEnd, "windowEnd");
  if (Date.parse(start) >= Date.parse(end)) throw new Error("The reporting window must have a positive duration.");
  if (resolutionEvidence.organizationId !== baseline.organizationId) throw new Error("Resolution evidence belongs to a different hotel workspace.");
  if (resolutionEvidence.category !== baseline.category) throw new Error("Resolution evidence does not match the baseline intent category.");
  const resolvedAt = Date.parse(resolutionEvidence.resolvedAt);
  if (Date.parse(baseline.sampleWindowEnd) >= resolvedAt ||
      Date.parse(baseline.attestedAt) >= resolvedAt ||
      resolvedAt >= Date.parse(baseline.reviewDueAt)) {
    throw new Error("The hotel baseline was not valid for this resolution event.");
  }
  if (resolvedAt < Date.parse(start) || resolvedAt >= Date.parse(end)) return null;

  return Object.freeze({
    metric: "potential_staff_minutes_avoided",
    status: "estimated",
    estimatedMinutes: baseline.medianActiveMinutes,
    eligibleConversationCount: 1,
    baselineSampleCount: baseline.sampleCount,
    baselineEvidenceStatus: "hotel_attested",
    baselineSourceType: baseline.sourceType,
    methodology: "baseline_median_active_handling_minutes_per_eligible_conversation",
    windowStart: start,
    windowEnd: end,
    coverage: "single_verified_event",
    disclaimer: "A counterfactual estimate based on a hotel-supplied historical median. It is not observed staff time, payroll savings, proof of causation, or incremental financial value."
  });
}

function aggregatePotentialStaffTimeAvoided({ baseline, resolutionEvidence = [], windowStart, windowEnd } = {}) {
  const start = requiredUtc(windowStart, "windowStart");
  const end = requiredUtc(windowEnd, "windowEnd");
  if (Date.parse(start) >= Date.parse(end)) throw new Error("The reporting window must have a positive duration.");
  if (!Array.isArray(resolutionEvidence)) throw new Error("resolutionEvidence must be an array.");
  if (!baseline) {
    return Object.freeze({
      metric: "potential_staff_minutes_avoided", status: "not_calculated",
      estimatedMinutes: null, eligibleConversationCount: null,
      reason: "hotel_baseline_missing", windowStart: start, windowEnd: end,
      disclaimer: "No hotel-attested historical handling-time baseline is configured. No time estimate is available."
    });
  }
  if (!VERIFIED_BASELINES.has(baseline)) throw new Error("A hotel-attested staff-time baseline created by this module is required.");

  const byEventId = new Map();
  const conflictingEventIds = new Set();
  let duplicateEventCount = 0;
  let outOfWindowEvidenceCount = 0;

  for (const evidence of resolutionEvidence) {
    if (!VERIFIED_RESOLUTIONS.has(evidence)) throw new Error("Every resolution record must be verifier-created evidence.");
    if (evidence.organizationId !== baseline.organizationId) throw new Error("Resolution evidence belongs to a different hotel workspace.");
    if (evidence.category !== baseline.category) throw new Error("Resolution evidence does not match the baseline intent category.");
    const occurredAt = Date.parse(evidence.resolvedAt);
    if (occurredAt < Date.parse(start) || occurredAt >= Date.parse(end)) {
      outOfWindowEvidenceCount += 1;
      continue;
    }
    if (Date.parse(baseline.sampleWindowEnd) >= occurredAt ||
        Date.parse(baseline.attestedAt) >= occurredAt ||
        occurredAt >= Date.parse(baseline.reviewDueAt)) {
      throw new Error("The hotel baseline was not valid for a resolution event in this report.");
    }

    const signature = [evidence.organizationId, evidence.conversationId, evidence.resolutionEventId, evidence.category, evidence.resolvedAt].join("|");
    const prior = byEventId.get(evidence.resolutionEventId);
    if (!prior) byEventId.set(evidence.resolutionEventId, { evidence, signature });
    else if (prior.signature === signature) duplicateEventCount += 1;
    else conflictingEventIds.add(evidence.resolutionEventId);
  }

  for (const eventId of conflictingEventIds) byEventId.delete(eventId);
  const byConversation = new Map();
  for (const { evidence } of byEventId.values()) {
    const list = byConversation.get(evidence.conversationId) || [];
    list.push(evidence);
    byConversation.set(evidence.conversationId, list);
  }

  const eligible = [];
  let ambiguousConversationCount = 0;
  for (const records of byConversation.values()) {
    if (records.length !== 1) {
      ambiguousConversationCount += 1;
      continue;
    }
    eligible.push(records[0]);
  }

  const common = {
    metric: "potential_staff_minutes_avoided",
    duplicateEventCount,
    conflictingEventIdCount: conflictingEventIds.size,
    ambiguousConversationCount,
    outOfWindowEvidenceCount,
    baselineSampleCount: baseline.sampleCount,
    baselineEvidenceStatus: "hotel_attested",
    windowStart: start,
    windowEnd: end,
    coverage: "provided_verified_events_only"
  };
  if (!eligible.length) {
    return Object.freeze({
      ...common, status: "not_calculated", estimatedMinutes: null,
      eligibleConversationCount: null,
      reason: "no_unambiguous_verified_resolution_events_in_window",
      disclaimer: "No eligible event was available in the supplied evidence set. This is not evidence that zero staff time was avoided or that the event feed is complete."
    });
  }

  return Object.freeze({
    ...common,
    status: "estimated_partial",
    estimatedMinutes: eligible.length * baseline.medianActiveMinutes,
    eligibleConversationCount: eligible.length,
    baselineSourceType: baseline.sourceType,
    methodology: "baseline_median_active_handling_minutes_per_eligible_conversation",
    disclaimer: "A partial counterfactual estimate based on a hotel-supplied historical median and supplied verified guest-resolution events. It is not observed staff time, payroll savings, proof of causation, or incremental financial value. Missing events are not counted as zero."
  });
}

module.exports = {
  CATEGORIES: Object.freeze(Array.from(CATEGORIES)),
  BASELINE_SOURCES: Object.freeze(Array.from(BASELINE_SOURCES)),
  createHotelStaffTimeBaseline,
  createVerifiedAiResolutionEvidence,
  estimatePotentialStaffTimeAvoided,
  aggregatePotentialStaffTimeAvoided
};
