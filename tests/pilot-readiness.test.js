const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_PILOT_CHECKS, buildPilotReadiness } = require("../pilot-readiness");

test("pilot readiness requires every declared check to be explicitly true", () => {
  const evidence = Object.fromEntries(REQUIRED_PILOT_CHECKS.map((key) => [key, true]));
  const result = buildPilotReadiness(evidence);

  assert.equal(result.readyForPilot, true);
  assert.deepEqual(Object.keys(result.checks), [...REQUIRED_PILOT_CHECKS]);
  assert.ok(Object.values(result.checks).every((value) => value === true));
});

test("pilot readiness stays blocked when any single check is missing or false", () => {
  for (const missingKey of REQUIRED_PILOT_CHECKS) {
    const evidence = Object.fromEntries(REQUIRED_PILOT_CHECKS.map((key) => [key, true]));
    delete evidence[missingKey];

    const result = buildPilotReadiness(evidence);
    assert.equal(result.readyForPilot, false, `missing ${missingKey} must block readiness`);
    assert.equal(result.checks[missingKey], false);
  }

  for (const falseKey of REQUIRED_PILOT_CHECKS) {
    const evidence = Object.fromEntries(REQUIRED_PILOT_CHECKS.map((key) => [key, true]));
    evidence[falseKey] = false;

    const result = buildPilotReadiness(evidence);
    assert.equal(result.readyForPilot, false, `${falseKey}=false must block readiness`);
  }
});

test("pilot readiness does not accept truthy strings or numbers as evidence", () => {
  const evidence = Object.fromEntries(REQUIRED_PILOT_CHECKS.map((key) => [key, true]));
  evidence.durableBackupsVerified = "true";
  evidence.hotelPrivacyApproved = 1;

  const result = buildPilotReadiness(evidence);
  assert.equal(result.readyForPilot, false);
  assert.equal(result.checks.durableBackupsVerified, false);
  assert.equal(result.checks.hotelPrivacyApproved, false);
});

test("unknown evidence keys cannot replace required checks", () => {
  const result = buildPilotReadiness({ everythingVerified: true });
  assert.equal(result.readyForPilot, false);
  assert.equal(Object.keys(result.checks).length, REQUIRED_PILOT_CHECKS.length);
});
