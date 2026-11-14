"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { requiresLiveAvailabilityCheck } = require("../guest-support-policy");

test("detects direct requests to check live room inventory", () => {
  for (const message of [
    "Can you check room availability for 18 December?",
    "Please confirm whether rooms are available next weekend",
    "Do you have rooms available from 20 to 23 December?",
    "Are any rooms available on Friday?"
  ]) assert.equal(requiresLiveAvailabilityCheck(message), true, message);
});

test("does not escalate general policy or process questions as live inventory checks", () => {
  for (const message of [
    "What is your cancellation policy?",
    "How does room availability work?",
    "What room types does the hotel offer?",
    "How can I make a reservation?"
  ]) assert.equal(requiresLiveAvailabilityCheck(message), false, message);
});

test("handles empty and unrelated messages", () => {
  assert.equal(requiresLiveAvailabilityCheck(""), false);
  assert.equal(requiresLiveAvailabilityCheck("Thank you, the breakfast was lovely."), false);
});
