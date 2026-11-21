"use strict";

const REQUIRED_BOOKING_CHECKS = Object.freeze([
  "pmsAdapterConfigured",
  "pmsAvailabilitySandboxTestPassed",
  "pmsBookingSandboxTestPassed",
  "quoteWorkflowIntegrated",
  "hotelBookingApproved",
  "hotelBookingPrivacyApproved",
  "pmsCredentialVaultConfigured",
]);

function buildBookingReadiness(evidence = {}) {
  const checks = Object.fromEntries(
    REQUIRED_BOOKING_CHECKS.map((key) => [key, evidence[key] === true])
  );
  return {
    readyForBookings: Object.values(checks).every(Boolean),
    checks,
  };
}

module.exports = { REQUIRED_BOOKING_CHECKS, buildBookingReadiness };
