"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRelevantKnowledge } = require("../hotel-knowledge");
const { buildLiveHotelContext } = require("../hotel-live-context");
const { requiresLiveAvailabilityCheck, requiresStaffEscalation } = require("../guest-support-policy");
const { validateAnswerGrounding } = require("../answer-grounding");

const hotelDocs = [
  { title: "Breakfast hours", category: "Dining", content: "Breakfast is served daily from 6:30 AM to 10:30 AM." },
  { title: "Check-in and check-out", category: "Guest services", content: "Check-in begins at 3:00 PM. Check-out is by 11:00 AM." },
  { title: "Guest parking", category: "Facilities", content: "Complimentary on-site guest parking is available in the hotel car park." },
  { title: "Accessibility", category: "Accessibility", content: "Step-free access is available at the main entrance. Please contact reception about specific room requirements." },
  { title: "Cancellation policy", category: "Reservations", content: "Cancellation terms depend on the rate selected. The cancellation deadline is shown in the booking confirmation." },
  { title: "Room availability", category: "Reservations", content: "Room availability changes in real time. Contact the hotel team to check specific dates; a policy document cannot confirm live inventory." }
];

test("hotel FAQ scenarios retrieve the matching approved policy rather than unrelated documents", () => {
  const scenarios = [
    ["What time is breakfast served?", "Breakfast hours"],
    ["What time can I check in?", "Check-in and check-out"],
    ["Is guest parking available?", "Guest parking"],
    ["Do you have wheelchair accessible entrance access?", "Accessibility"],
    ["What is the cancellation policy?", "Cancellation policy"],
    ["How do I check room availability?", "Room availability"]
  ];

  for (const [question, expectedTitle] of scenarios) {
    const result = buildRelevantKnowledge(question, hotelDocs);
    assert.equal(result.matched, true, question);
    assert.equal(result.sources[0].title, expectedTitle, question);
    assert.equal(result.fallbackUsed, false, question);
  }
});

test("unsupported amenity questions do not borrow unrelated hotel facts", () => {
  const result = buildRelevantKnowledge("Do you offer helicopter transfers?", hotelDocs);
  assert.equal(result.matched, false);
  assert.equal(result.noRelevantKnowledge, true);
  assert.equal(result.sources.length, 0);
  assert.equal(result.fallbackUsed, false);
});

test("hotel policy answers can repeat approved breakfast and check-in times but not invent new times", () => {
  const context = "Breakfast is served daily from 6:30 AM to 10:30 AM. Check-in begins at 3:00 PM.";
  assert.equal(validateAnswerGrounding("Breakfast is from 6:30 to 10:30.", context).supported, true);
  const unsupported = validateAnswerGrounding("Breakfast is from 6:30 to 11:00.", context);
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.reason, "unsupported_numeric_claim");
});

test("booking-process and cancellation policy questions remain informational, while changes and new bookings go to staff", () => {
  assert.equal(requiresStaffEscalation("How do I make a reservation?"), false);
  assert.equal(requiresStaffEscalation("What is the cancellation policy?"), false);
  assert.equal(requiresStaffEscalation("Please cancel my reservation."), true);
  assert.equal(requiresStaffEscalation("Please book me a room for Friday."), true);
  for (const message of [
    "I have a serious food allergy.",
    "There is a fire in the hotel.",
    "I was charged twice and need a refund.",
    "Please arrange late check-out for me.",
    "Can I speak to a real person?"
  ]) assert.equal(requiresStaffEscalation(message), true, message);
  assert.equal(requiresStaffEscalation("What time does breakfast start?"), false);
});

test("live room inventory questions are distinguished from general room-policy questions", () => {
  assert.equal(requiresLiveAvailabilityCheck("How does room availability work?"), false);
  assert.equal(requiresLiveAvailabilityCheck("Can you check room availability for 12 December?"), true);
});

test("expired and future-dated room snapshots are excluded from guest-facing live context", () => {
  const nowUtc = "2026-11-14T12:00:00.000Z";
  const snapshot = (sourceEventId, observedAt, validUntil) => ({
    propertyReference: "hotel-1",
    roomTypeCode: "DELUXE",
    arrivalDate: "2026-12-10",
    departureDate: "2026-12-11",
    roomsAvailable: 2,
    observedAt,
    validUntil,
    sourceEventId
  });
  const result = buildLiveHotelContext({
    nowUtc,
    availabilitySnapshots: [
      snapshot("fresh", "2026-11-14T11:55:00.000Z", "2026-11-14T12:05:00.000Z"),
      snapshot("expired", "2026-11-14T11:30:00.000Z", "2026-11-14T11:45:00.000Z"),
      snapshot("future", "2026-11-14T12:01:00.000Z", "2026-11-14T12:10:00.000Z")
    ]
  });
  assert.equal(result.availabilityCount, 1);
  assert.match(result.context, /2 room\(s\) reported available/);
  assert.doesNotMatch(result.context, /expired|future/);
});

test("no current room snapshot produces an explicit no-availability-claim instruction", () => {
  const result = buildLiveHotelContext({ nowUtc: "2026-11-14T12:00:00.000Z" });
  assert.equal(result.availabilityCount, 0);
  assert.match(result.context, /Do not state or imply that rooms are available/);
});
