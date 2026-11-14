"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateAnswerGrounding } = require("../answer-grounding");

test("accepts numeric facts present in approved hotel knowledge", () => {
  assert.deepEqual(
    validateAnswerGrounding("Breakfast is served from 6:30 to 10:30.", "Breakfast hours are 6:30 to 10:30."),
    { supported: true, reason: "", unsupportedNumbers: [] }
  );
});

test("rejects new numeric claims that are absent from approved knowledge", () => {
  const result = validateAnswerGrounding("Breakfast is served from 6:30 to 11:00.", "Breakfast hours are 6:30 to 10:30.");
  assert.equal(result.supported, false);
  assert.equal(result.reason, "unsupported_numeric_claim");
  assert.deepEqual(result.unsupportedNumbers, ["11", "00"]);
});

test("allows a reply to repeat numbers supplied by the guest", () => {
  const result = validateAnswerGrounding("Your requested dates are 12 to 14 December.", "Check-in is at 15:00.", "I need 12 to 14 December.");
  assert.equal(result.supported, true);
});

test("fails closed when there is no approved context or no reply", () => {
  assert.equal(validateAnswerGrounding("Check-in is at 3pm.", "").supported, false);
  assert.equal(validateAnswerGrounding("", "Check-in is at 3pm.").reason, "empty_reply");
});


test("rejects email addresses and website links absent from approved information", () => {
  const email = validateAnswerGrounding(
    "Email us at bookings@example.com.",
    "The hotel front desk can help with questions."
  );
  assert.equal(email.supported, false);
  assert.equal(email.reason, "unsupported_contact_detail");
  assert.deepEqual(email.unsupportedContacts, ["bookings@example.com"]);

  const url = validateAnswerGrounding(
    "Book at https://example.com/reserve.",
    "The hotel accepts booking enquiries by phone."
  );
  assert.equal(url.supported, false);
  assert.equal(url.reason, "unsupported_contact_detail");
  assert.deepEqual(url.unsupportedContacts, ["https://example.com/reserve"]);
});

test("allows contact details explicitly present in approved information", () => {
  const result = validateAnswerGrounding(
    "Email bookings@example.com or visit https://example.com/reserve.",
    "Contact bookings@example.com or visit https://example.com/reserve."
  );
  assert.equal(result.supported, true);
});
