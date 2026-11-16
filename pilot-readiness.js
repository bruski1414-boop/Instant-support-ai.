const REQUIRED_PILOT_CHECKS = Object.freeze([
  "databaseConnected",
  "aiConfigured",
  "guestDataStorageEnabled",
  "staffWebhookConfigured",
  "durableBackupsVerified",
  "tenantIsolationTestsPassed",
  "providerOAuthTested",
  "hotelPrivacyApproved",
  "staffHandoffTested",
  "pilotReleaseApproved",
]);

const FAQ_PILOT_REQUIRED_CHECKS = Object.freeze(REQUIRED_PILOT_CHECKS.filter((key) => key !== "providerOAuthTested"));

function buildFaqPilotReadiness(evidence = {}) {
  const checks = Object.fromEntries(
    FAQ_PILOT_REQUIRED_CHECKS.map((key) => [key, evidence[key] === true])
  );
  return {
    readyForPilot: Object.values(checks).every(Boolean),
    checks,
  };
}

function buildPilotReadiness(evidence = {}) {
  const checks = Object.fromEntries(
    REQUIRED_PILOT_CHECKS.map((key) => [key, evidence[key] === true])
  );
  return {
    readyForPilot: Object.values(checks).every(Boolean),
    checks,
  };
}

module.exports = { REQUIRED_PILOT_CHECKS, FAQ_PILOT_REQUIRED_CHECKS, buildPilotReadiness, buildFaqPilotReadiness };
