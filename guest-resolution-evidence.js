"use strict";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GUEST_TOKEN = /^[A-Za-z0-9_-]{40,64}$/;
const WINDOW_HOURS = 720;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

function parseResolutionConfirmationInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const conversationToken = typeof body.conversationToken === "string" ? body.conversationToken : "";
  const assistantMessageId = typeof body.assistantMessageId === "string" ? body.assistantMessageId.trim() : "";
  if (!UUID.test(conversationId) || !UUID.test(assistantMessageId) || !GUEST_TOKEN.test(conversationToken)) return null;
  return Object.freeze({ conversationId, conversationToken, assistantMessageId });
}

function safeCount(value, field) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(field + " must be a non-negative safe integer");
  }
  return count;
}

function buildResolutionEvidenceReport(row, windowStart, windowEnd) {
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() - start.getTime() !== WINDOW_MS) {
    throw new TypeError("Resolution evidence window must be exactly 720 hours");
  }
  const guestReportedConversations = safeCount(row?.guest_reported_conversations, "guest_reported_conversations");
  const selfServiceCandidates = safeCount(row?.self_service_candidates, "self_service_candidates");
  if (selfServiceCandidates > guestReportedConversations) {
    throw new TypeError("self-service candidates cannot exceed guest-reported conversations");
  }
  return Object.freeze({
    windowHours: WINDOW_HOURS,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    guestReportedConversations,
    selfServiceCandidates,
    assistedOrAmbiguousConversations: guestReportedConversations - selfServiceCandidates,
    influencedConversations: Object.freeze({ status: "not_measured", value: null }),
    potentialStaffMinutesAvoided: Object.freeze({
      status: "not_calculated",
      value: null,
      reason: "No reviewed hotel-specific historical active-handling-time baseline is connected to these events."
    }),
    note: "Guest confirmations are self-reported. A self-service candidate has one confirmation, no recorded staff message or escalation, and no later conversation message. This does not verify answer accuracy or prove causation."
  });
}

module.exports = {
  WINDOW_HOURS,
  parseResolutionConfirmationInput,
  buildResolutionEvidenceReport
};
