const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_PILOT_CHECKS, buildPilotReadiness } = require("../pilot-readiness");

test("pilot readiness passes only when every required check is explicitly true", () => {
  const evidence = Object.fromEntries(REQUIRED_PILOT_CHECKS.map((key) => [key, true]));
  const result = buildPilotReadiness(evidence);
  assert.equal(result.readyForPilot, true);
  assert.deepEqual(result.checks, evidence);
});

test("pilot readiness fails closed when any required check is missing or false", () => {
  for (const missingKey of REQUIRED_PILOT_CHECKS) {
    const evidence = Object.fromEntries(REQUIRED_PILOT_CHECKS.map((key) => [key, true]));
    delete evidence[missingKey];
    const result = buildPilotReadiness(evidence);
    assert.equal(result.readyForPilot, false, missingKey);
    assert.equal(result.checks[missingKey], false, missingKey);
  }
});

test("pilot readiness rejects truthy values that are not the boolean true", () => {
  for (const value of ["true", 1, {}, null]) {
    const evidence = Object.fromEntries(REQUIRED_PILOT_CHECKS.map((key) => [key, true]));
    evidence.durableBackupsVerified = value;
    assert.equal(buildPilotReadiness(evidence).readyForPilot, false);
  }
});
