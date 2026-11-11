const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BUSINESS_NAME, FAQ } = require("../fixtures/northstar-hotel");
const { shouldEscalate } = require("../server");

test("Northstar demo is clearly fictional and contains the approved guest facts", () => {
  assert.match(BUSINESS_NAME, /fictional demo/i);
  assert.match(FAQ, /entirely fictional/i);
  for (const fact of [
    "3:00 PM", "11:00 AM", "7:00 AM to 10:30 AM",
    "Ocean Terrace", "7:00 AM to 8:00 PM", "6:00 AM to 10:00 PM",
  ]) assert.ok(FAQ.includes(fact), `missing approved demo fact: ${fact}`);
});

test("unknown hotel policies are explicitly marked as unverified", () => {
  for (const topic of ["Wi-Fi password", "room rates", "room availability", "pet policy", "parking policy"]) {
    assert.match(FAQ, new RegExp(topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.match(FAQ, /staff must confirm the price and availability/i);
  assert.match(FAQ, /Never make bookings, change reservations, confirm availability, quote unverified prices, or issue refunds/i);
});

test("sensitive fictional-hotel requests trigger deterministic staff escalation", () => {
  for (const message of [
    "Please cancel my reservation.",
    "Please refund me.",
    "I have a severe food allergy.",
    "My room is dirty and I want to complain.",
    "There is a fire in my room.",
  ]) assert.equal(shouldEscalate(message), true, message);
  for (const message of [
    "What time can I check in?",
    "When is breakfast served?",
    "What time does the pool close?",
    "Is the fitness room open?",
  ]) assert.equal(shouldEscalate(message), false, message);
});

test("live evaluation uses the shared fictional fixture and covers guest-to-staff risks", () => {
  const source = fs.readFileSync(path.join(__dirname, "live-eval.js"), "utf8");
  assert.match(source, /fixtures\/northstar-hotel/);
  assert.match(source, /No real guest data is used/);
  assert.match(source, /cancellation and refund/i);
  assert.match(source, /food allergy/i);
  assert.match(source, /prompt injection/i);
  assert.match(source, /15 fictional-hotel live evaluations/);
});
