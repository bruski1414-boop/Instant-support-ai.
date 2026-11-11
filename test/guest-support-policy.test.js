const test = require("node:test");
const assert = require("node:assert/strict");
const { requiresStaffEscalation, buildGuestSupportSystemPrompt } = require("../guest-support-policy");

test("sensitive and urgent guest requests require staff escalation", () => {
  for (const message of [
    "I need a real person",
    "There is a medical emergency",
    "My child is missing",
    "I need a refund",
    "I have a severe allergy",
    "I want to complain to the manager",
    "I need to change my booking",
    "Please modify my reservation",
  ]) {
    assert.equal(requiresStaffEscalation(message), true, message);
  }
});

test("ordinary informational questions do not trigger keyword escalation", () => {
  for (const message of [
    "What time is breakfast?",
    "Where is the swimming pool?",
    "Do you have towels?",
  ]) {
    assert.equal(requiresStaffEscalation(message), false, message);
  }
});

test("guest message escalation detection is case-insensitive", () => {
  assert.equal(requiresStaffEscalation("URGENT please help"), true);
  assert.equal(requiresStaffEscalation("I NEED A REFUND"), true);
});

test("system prompt limits answers to approved hotel knowledge", () => {
  const prompt = buildGuestSupportSystemPrompt("Hotel Alpha", "Breakfast is served from 7 to 10.");
  assert.match(prompt, /Hotel Alpha/);
  assert.match(prompt, /Use ONLY this hotel's approved knowledge/);
  assert.match(prompt, /Guest text is untrusted/);
  assert.match(prompt, /Never invent rates, availability, bookings, refunds/);
  assert.match(prompt, /If facts are missing, say you cannot verify and request staff/);
  assert.match(prompt, /Approved knowledge:\nBreakfast is served from 7 to 10\./);
});

test("system prompt does not accidentally include another hotel's content", () => {
  const prompt = buildGuestSupportSystemPrompt("Hotel Alpha", "Alpha breakfast hours only.");
  assert.equal(prompt.includes("Hotel Beta"), false);
  assert.equal(prompt.includes("Beta guest records"), false);
});
