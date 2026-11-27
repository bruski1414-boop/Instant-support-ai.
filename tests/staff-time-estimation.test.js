"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("../fixtures/staff-time-estimation");
const {
  createHotelStaffTimeBaseline,
  createVerifiedAiResolutionEvidence,
  estimatePotentialStaffTimeAvoided,
  aggregatePotentialStaffTimeAvoided
} = require("../staff-time-estimation");

const WINDOW_START = "2026-11-01T00:00:00.000Z";
const WINDOW_END = "2026-11-30T00:00:00.000Z";

function baseline(overrides = {}) {
  return createHotelStaffTimeBaseline({
    organizationId: fixture.organizationId,
    attestedBy: fixture.attestedBy,
    category: "dining",
    medianActiveMinutes: 7,
    sampleCount: 24,
    sourceType: "historical_work_log",
    evidenceReference: "SYNTHETIC-DINING-WORKLOG",
    sampleWindowStart: "2026-10-01T00:00:00.000Z",
    sampleWindowEnd: "2026-10-31T23:59:59.999Z",
    attestedAt: "2026-10-31T23:59:59.999Z",
    reviewDueAt: "2026-12-01T00:00:00.000Z",
    ...overrides
  });
}

async function verified(event, overrides = {}) {
  const input = { ...event, ...overrides };
  return createVerifiedAiResolutionEvidence({
    ...input,
    verify: async candidate => ({
      verified: candidate.organizationId === fixture.organizationId &&
        candidate.guestConfirmedResolved === true &&
        candidate.staffTouchCount === 0 &&
        candidate.escalationCount === 0,
      method: "internal_event_chain"
    })
  });
}

async function allFixtureEvidence() {
  return Promise.all(fixture.resolutionEvents.map(event => verified(event)));
}

test("synthetic hotel baseline is explicit, immutable and labelled as hotel-attested", () => {
  assert.match(fixture.label, /^SYNTHETIC TEST DATA ONLY/);
  assert.equal(Object.isFrozen(fixture.baseline), true);
  assert.equal(fixture.baseline.evidenceStatus, "hotel_attested");
  assert.equal(fixture.baseline.medianActiveMinutes, 7);
  assert.equal(fixture.baseline.sampleCount, 24);
  assert.equal(fixture.baseline.methodology, "median_active_handling_minutes");
  assert.match(fixture.baseline.evidenceReferenceHash, /^[a-f0-9]{64}$/);
  assert.equal("evidenceReference" in fixture.baseline, false);
});

test("baseline rejects missing samples, unsupported sources, URLs and invalid chronology", () => {
  const base = {
    organizationId: fixture.organizationId,
    attestedBy: fixture.attestedBy,
    category: "dining",
    medianActiveMinutes: 7,
    sampleCount: 24,
    sourceType: "historical_work_log",
    evidenceReference: "SYNTHETIC-WORKLOG",
    sampleWindowStart: "2026-10-01T00:00:00.000Z",
    sampleWindowEnd: "2026-10-31T23:59:59.999Z",
    attestedAt: "2026-11-01T00:00:00.000Z",
    reviewDueAt: "2026-12-01T00:00:00.000Z"
  };
  for (const patch of [
    { sampleCount: 0 },
    { medianActiveMinutes: 0 },
    { medianActiveMinutes: 481 },
    { sourceType: "manager_guess" },
    { evidenceReference: "https://example.invalid/report" },
    { sampleWindowEnd: "2026-11-02T00:00:00.000Z" },
    { reviewDueAt: "2026-11-01T00:00:00.000Z" },
    { sampleWindowStart: "2026-10-31T00:00:00.000Z", sampleWindowEnd: "2026-10-01T00:00:00.000Z" }
  ]) {
    assert.throws(() => createHotelStaffTimeBaseline({ ...base, ...patch }));
  }
});

test("resolution evidence requires guest confirmation and zero staff touches and escalations", async () => {
  const event = fixture.resolutionEvents[0];
  await assert.rejects(() => verified(event, { guestConfirmedResolved: false }));
  await assert.rejects(() => verified(event, { staffTouchCount: 1 }));
  await assert.rejects(() => verified(event, { escalationCount: 1 }));
  await assert.rejects(() => createVerifiedAiResolutionEvidence({
    ...event,
    verify: async () => ({ verified: false, method: "internal_event_chain" })
  }));
});

test("a plain JSON object cannot be used as verified resolution evidence", () => {
  assert.throws(() => estimatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: { ...fixture.resolutionEvents[0] },
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  }));
});

test("one eligible event produces a labelled estimate from the category-matched historical median", async () => {
  const evidence = await verified(fixture.resolutionEvents[2]);
  const estimate = estimatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: evidence,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  });
  assert.equal(estimate.metric, "potential_staff_minutes_avoided");
  assert.equal(estimate.status, "estimated");
  assert.equal(estimate.estimatedMinutes, 7);
  assert.equal(estimate.eligibleConversationCount, 1);
  assert.equal(estimate.baselineEvidenceStatus, "hotel_attested");
  assert.match(estimate.disclaimer, /not observed staff time/i);
  assert.equal("conversationId" in estimate, false);
  assert.equal("evidenceReference" in estimate, false);
});

test("estimate rejects cross-tenant, category-mismatched and expired baseline evidence", async () => {
  const event = fixture.resolutionEvents[2];
  await assert.rejects(() => verified(event, {
    organizationId: "88888888-8888-4888-8888-888888888888"
  }));

  const wrongCategory = await verified(event, { category: "transport" });
  assert.throws(() => estimatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: wrongCategory,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  }));

  const expired = baseline({ reviewDueAt: "2026-11-15T00:00:00.000Z" });
  const expiredEvidence = await verified(event);
  assert.throws(() => estimatePotentialStaffTimeAvoided({
    baseline: expired,
    resolutionEvidence: expiredEvidence,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  }));
});

test("reporting window includes its start and excludes its end", async () => {
  const atStart = await verified(fixture.resolutionEvents[0]);
  const atEnd = await verified(fixture.resolutionEvents[3]);
  const included = estimatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: atStart,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  });
  const excluded = estimatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: atEnd,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  });
  assert.equal(included.estimatedMinutes, 7);
  assert.equal(excluded, null);
});

test("aggregate deduplicates exact replays and excludes ambiguous repeat resolutions per conversation", async () => {
  const evidence = await allFixtureEvidence();
  const report = aggregatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: [evidence[0], evidence[0], evidence[1], evidence[2], evidence[3]],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  });
  assert.equal(report.status, "estimated_partial");
  assert.equal(report.estimatedMinutes, 7);
  assert.equal(report.eligibleConversationCount, 1);
  assert.equal(report.duplicateEventCount, 1);
  assert.equal(report.ambiguousConversationCount, 1);
  assert.equal(report.outOfWindowEvidenceCount, 1);
  assert.equal(report.coverage, "provided_verified_events_only");
  assert.match(report.disclaimer, /Missing events are not counted as zero/);
});

test("conflicting reuse of one resolution event ID is excluded rather than guessed", async () => {
  const first = await verified(fixture.resolutionEvents[2]);
  const second = await verified(fixture.resolutionEvents[2], {
    conversationId: "99999999-9999-4999-8999-999999999999"
  });
  const report = aggregatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: [first, second],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  });
  assert.equal(report.status, "not_calculated");
  assert.equal(report.estimatedMinutes, null);
  assert.equal(report.conflictingEventIdCount, 1);
});

test("missing baseline or missing verified events is not reported as zero savings", async () => {
  const missingBaseline = aggregatePotentialStaffTimeAvoided({
    baseline: null,
    resolutionEvidence: [],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  });
  assert.equal(missingBaseline.status, "not_calculated");
  assert.equal(missingBaseline.estimatedMinutes, null);
  assert.equal(missingBaseline.eligibleConversationCount, null);

  const missingEvents = aggregatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: [],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  });
  assert.equal(missingEvents.status, "not_calculated");
  assert.equal(missingEvents.estimatedMinutes, null);
  assert.equal(missingEvents.eligibleConversationCount, null);
});

test("cross-tenant evidence is rejected even when its timestamp is outside the report window", async () => {
  const event = fixture.resolutionEvents[2];
  const foreign = await createVerifiedAiResolutionEvidence({
    ...event,
    organizationId: "88888888-8888-4888-8888-888888888888",
    resolvedAt: "2026-10-15T12:00:00.000Z",
    verify: async () => ({ verified: true, method: "internal_event_chain" })
  });
  assert.throws(() => aggregatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: [foreign],
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  }), /different hotel workspace/);
});

test("report rejects incomplete or invalid reporting windows", () => {
  assert.throws(() => aggregatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: [],
    windowStart: WINDOW_END,
    windowEnd: WINDOW_START
  }));
  assert.throws(() => aggregatePotentialStaffTimeAvoided({
    baseline: fixture.baseline,
    resolutionEvidence: [],
    windowStart: "2026-11-01T00:00:00+07:00",
    windowEnd: WINDOW_END
  }));
});
