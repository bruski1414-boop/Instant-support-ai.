"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DEMO_METRICS, SAMPLE_STAY, respondToDemoMessage } = require("../demo-mode");

test("demo metrics are clearly synthetic and separate reported from linked revenue", () => {
  assert.equal(DEMO_METRICS.demoOnly, true);
  assert.equal(DEMO_METRICS.conversations, 126);
  assert.equal(DEMO_METRICS.resolvedWithoutStaff + DEMO_METRICS.staffHandoffs, 126);
  assert.equal(DEMO_METRICS.veyraLinkedRevenueMinor, 0);\n  assert.equal(DEMO_METRICS.medianFirstResponseSeconds, 8);
  assert.match(DEMO_METRICS.note, /not attributed to Veyra/);
});

test("answers common hotel questions from the demo knowledge base", () => {
  assert.match(respondToDemoMessage("What time is check-in?").reply, /3:00 PM/);
  assert.match(respondToDemoMessage("When is breakfast?").reply, /6:30 AM to 10:30 AM/);
  assert.match(respondToDemoMessage("Is the pool open?").reply, /7:00 AM to 9:00 PM/);
  assert.match(respondToDemoMessage("What is the Wi-Fi password?").reply, /Aster-Guest/);
});

test("full-stay sample availability uses the minimum inventory across each night", () => {
  const result = respondToDemoMessage("Can you check room availability?", SAMPLE_STAY);
  assert.equal(result.needsHuman, false);
  assert.match(result.reply, /Deluxe: 2 sample room/);
  assert.match(result.reply, /Garden Suite: 1 sample room/);
  assert.match(result.reply, /simulated data only/);
});

test("availability outside the fixed sample stay is escalated, not invented", () => {
  const result = respondToDemoMessage("Are rooms available?", {
    arrivalDate: "2026-12-20", departureDate: "2026-12-22"
  });
  assert.equal(result.needsHuman, true);
  assert.equal(result.handoffStatus, "demo_queue_only");
  assert.match(result.reply, /can’t verify those dates/);
});

test("booking actions and sensitive requests are handed off", () => {
  assert.equal(respondToDemoMessage("Please book me a room").needsHuman, true);
  assert.equal(respondToDemoMessage("I have a severe food allergy").needsHuman, true);
  assert.equal(respondToDemoMessage("I need a refund").needsHuman, true);
});

test("unknown questions go to a simulated staff queue without claiming notification", () => {
  const result = respondToDemoMessage("Can you arrange a helicopter tour?");
  assert.equal(result.needsHuman, true);
  assert.equal(result.handoffStatus, "demo_queue_only");
  assert.match(result.reply, /simulated only/);
});

test("rejects empty, oversized and invalid stay dates", () => {
  assert.throws(() => respondToDemoMessage(""), /between 1 and 1,200/);
  assert.throws(() => respondToDemoMessage("x".repeat(1201)), /between 1 and 1,200/);
  const result = respondToDemoMessage("Check room availability", {
    arrivalDate: "2026-02-30", departureDate: "2026-12-12"
  });
  assert.equal(result.needsHuman, true);
});
