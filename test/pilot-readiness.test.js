const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_PILOT_CHECKS, buildPilotReadiness } = require("../pilot-readiness");

const allEvidence = Object.fromEntries(REQUIRED_PILOT_CHECKS.map((key) => [key, true]));

test("pilot readiness requires every release gate", () => {
  const result = buildPilotReadiness(allEvidence);
  assert.equal(result.readyForPilot, true);
  assert.equal(Object.keys(result.checks).length, 12);
  assert.ok(Object.values(result.checks).every(Boolean));
});

test("missing tenant isolation evidence blocks pilot readiness", () => {
  const evidence = { ...allEvidence, tenantIsolationTestsPassed: false };
  const result = buildPilotReadiness(evidence);
  assert.equal(result.readyForPilot, false);
  assert.equal(result.checks.tenantIsolationTestsPassed, false);
});

test("unverified client IP rate limiting blocks pilot readiness", () => {
  const evidence = { ...allEvidence, clientIpRateLimitVerified: false };
  const result = buildPilotReadiness(evidence);
  assert.equal(result.readyForPilot, false);
  assert.equal(result.checks.clientIpRateLimitVerified, false);
});

test("missing privacy, backups or handoff evidence blocks pilot readiness", () => {
  for (const key of ["platformPrivacyReviewPassed", "retentionEnforcementVerified", "durableBackupsVerified", "staffHandoffTested"]) {
    const evidence = { ...allEvidence, [key]: false };
    assert.equal(buildPilotReadiness(evidence).readyForPilot, false, key);
  }
});

test("truthy strings do not count as release evidence", () => {
  const evidence = { ...allEvidence, providerOAuthTested: "true" };
  const result = buildPilotReadiness(evidence);
  assert.equal(result.readyForPilot, false);
  assert.equal(result.checks.providerOAuthTested, false);
});

test("an empty evidence record is safely not ready", () => {
  const result = buildPilotReadiness();
  assert.equal(result.readyForPilot, false);
  assert.ok(Object.values(result.checks).every((value) => value === false));
});
