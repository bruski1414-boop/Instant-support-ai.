"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  WINDOW_HOURS,
  parseResolutionConfirmationInput,
  buildResolutionEvidenceReport
} = require("../guest-resolution-evidence.js");

const conversationId = "11111111-1111-4111-8111-111111111111";
const assistantMessageId = "22222222-2222-4222-8222-222222222222";
const conversationToken = "A".repeat(43);

test("resolution request accepts only a guest token and two UUID references", () => {
  const parsed = parseResolutionConfirmationInput({ conversationId, assistantMessageId, conversationToken, organizationId: "attacker-controlled" });
  assert.deepEqual(parsed, { conversationId, assistantMessageId, conversationToken });
  assert.equal(Object.isFrozen(parsed), true);
});

test("resolution request rejects malformed, missing and array payloads", () => {
  assert.equal(parseResolutionConfirmationInput(null), null);
  assert.equal(parseResolutionConfirmationInput([]), null);
  assert.equal(parseResolutionConfirmationInput({ conversationId, assistantMessageId, conversationToken: "short" }), null);
  assert.equal(parseResolutionConfirmationInput({ conversationId: "not-a-uuid", assistantMessageId, conversationToken }), null);
  assert.equal(parseResolutionConfirmationInput({ conversationId, assistantMessageId: "not-a-uuid", conversationToken }), null);
  assert.equal(parseResolutionConfirmationInput({ conversationId, assistantMessageId, conversationToken: "x".repeat(65) }), null);
});

test("resolution evidence report exposes counts but no personal or conversation identifiers", () => {
  const end = new Date("2026-11-28T09:00:00.000Z");
  const start = new Date(end.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
  const report = buildResolutionEvidenceReport({
    guest_reported_conversations: "8",
    self_service_candidates: "5"
  }, start, end);
  assert.equal(report.windowHours, 720);
  assert.equal(report.windowStart, start.toISOString());
  assert.equal(report.windowEnd, end.toISOString());
  assert.equal(report.guestReportedConversations, 8);
  assert.equal(report.selfServiceCandidates, 5);
  assert.equal(report.assistedOrAmbiguousConversations, 3);
  assert.deepEqual(report.influencedConversations, { status: "not_measured", value: null });
  assert.equal(report.potentialStaffMinutesAvoided.status, "not_calculated");
  assert.equal(report.potentialStaffMinutesAvoided.value, null);
  assert.equal(JSON.stringify(report).includes(conversationId), false);
  assert.equal(JSON.stringify(report).includes(assistantMessageId), false);
  assert.equal(JSON.stringify(report).includes(conversationToken), false);
});

test("resolution report fails closed on invalid counts or non-720-hour windows", () => {
  const end = new Date("2026-11-28T09:00:00.000Z");
  const start = new Date(end.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
  assert.throws(() => buildResolutionEvidenceReport({ guest_reported_conversations: -1, self_service_candidates: 0 }, start, end), /non-negative/);
  assert.throws(() => buildResolutionEvidenceReport({ guest_reported_conversations: 2.5, self_service_candidates: 1 }, start, end), /safe integer/);
  assert.throws(() => buildResolutionEvidenceReport({ guest_reported_conversations: 1, self_service_candidates: 2 }, start, end), /cannot exceed/);
  assert.throws(() => buildResolutionEvidenceReport({ guest_reported_conversations: 0, self_service_candidates: 0 }, start, end - 1), /720 hours/);
});

test("server, widget and dashboard expose only explicit guest-confirmed resolution semantics", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const widget = fs.readFileSync("widget.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /conversation_resolution_confirmations/);
  assert.match(server, /app\.post\("\/api\/public\/:slug\/resolution"/);
  assert.match(server, /app\.get\("\/api\/admin\/resolution-evidence"/);
  assert.match(server, /guest_token_hash=\$3/);
  assert.match(widget, /My question is resolved/);
  assert.match(dashboard, /Guest-confirmed resolution evidence/);
  assert.match(dashboard, /potential staff minutes avoided/i);
  assert.match(dashboard, /Influenced conversations: not measured/);
});
