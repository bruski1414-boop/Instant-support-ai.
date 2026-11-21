"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_BOOKING_CHECKS, buildBookingReadiness } = require("../booking-readiness");

test("booking readiness requires every safety and integration check", () => {
  const evidence = Object.fromEntries(REQUIRED_BOOKING_CHECKS.map((key) => [key, true]));
  const result = buildBookingReadiness(evidence);
  assert.equal(result.readyForBookings, true);
  assert.deepEqual(Object.keys(result.checks), [...REQUIRED_BOOKING_CHECKS]);
  assert.ok(Object.values(result.checks).every(Boolean));
});

test("booking readiness stays blocked when any check is missing or false", () => {
  for (const missing of REQUIRED_BOOKING_CHECKS) {
    const evidence = Object.fromEntries(REQUIRED_BOOKING_CHECKS.map((key) => [key, true]));
    delete evidence[missing];
    const result = buildBookingReadiness(evidence);
    assert.equal(result.readyForBookings, false, missing + " must block bookings");
    assert.equal(result.checks[missing], false);
  }
});

test("truthy strings and numbers cannot satisfy booking readiness", () => {
  const evidence = Object.fromEntries(REQUIRED_BOOKING_CHECKS.map((key) => [key, true]));
  evidence.hotelBookingApproved = "true";
  evidence.pmsBookingSandboxTestPassed = 1;
  const result = buildBookingReadiness(evidence);
  assert.equal(result.readyForBookings, false);
  assert.equal(result.checks.hotelBookingApproved, false);
  assert.equal(result.checks.pmsBookingSandboxTestPassed, false);
});

test("unknown evidence cannot substitute for required booking checks", () => {
  const result = buildBookingReadiness({ everythingApproved: true });
  assert.equal(result.readyForBookings, false);
  assert.equal(Object.keys(result.checks).length, REQUIRED_BOOKING_CHECKS.length);
});
