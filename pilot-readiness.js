const REQUIRED_PILOT_CHECKS = Object.freeze([
  "databaseConnected",
  "aiConfigured",
  "guestDataStorageEnabled",
  "staffWebhookConfigured",
  "durableBackupsVerified",
  "tenantIsolationTestsPassed",
  "providerOAuthTested",
  "clientIpRateLimitVerified",
  "platformPrivacyReviewPassed",
  "retentionEnforcementVerified",
  "staffHandoffTested",
  "pilotReleaseApproved",
]);

function buildPilotReadiness(evidence = {}) {
  const checks = Object.fromEntries(
    REQUIRED_PILOT_CHECKS.map((key) => [key, evidence[key] === true])
  );
  return {
    readyForPilot: Object.values(checks).every(Boolean),
    checks,
  };
}

module.exports = { REQUIRED_PILOT_CHECKS, buildPilotReadiness };
