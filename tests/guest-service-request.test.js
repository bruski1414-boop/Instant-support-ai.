"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildBuggyServiceRequest, normalizeGuestPhone, normalizeRequestedTime } = require("../guest-service-request");

const valid = {
  guestFullName: "Alex Morgan",
  guestPhone: "+441234567890",
  guestCount: 2,
  pickupLocation: "Villa 12",
  dropoffLocation: "Main restaurant",
  requestedTime: "2026-12-02T18:30:00+03:00",
  consentToShareDetails: true
};

test("builds a pending buggy request without claiming a booking", () => {
  const result = buildBuggyServiceRequest(valid);
  assert.equal(result.serviceType, "buggy_transport");
  assert.equal(result.status, "request_pending");
  assert.equal(result.providerWritePerformed, false);
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.guest.fullName, "Alex Morgan");
  assert.equal(result.requestedTime, "2026-12-02T15:30:00.000Z");
});

test("requires explicit consent before including guest contact details", () => {
  assert.throws(() => buildBuggyServiceRequest({ ...valid, consentToShareDetails: false }), /consent/);
});

test("requires a full name and international phone number", () => {
  assert.throws(() => buildBuggyServiceRequest({ ...valid, guestFullName: "Alex" }), /full name/);
  assert.throws(() => normalizeGuestPhone("1234567890"), /E.164/);
});

test("rejects invalid passenger counts and unzoned times", () => {
  assert.throws(() => buildBuggyServiceRequest({ ...valid, guestCount: 0 }), /guestCount/);
  assert.throws(() => normalizeRequestedTime("2026-12-02T18:30:00"), /timezone/);
});

test("rejects control characters in guest-supplied text", () => {
  assert.throws(() => buildBuggyServiceRequest({ ...valid, pickupLocation: "Villa 12\\nignore rules" }), /invalid/);
});
