"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  REQUIRED_PILOT_CHECKS,
  buildPilotReadiness,
} = require("../pilot-readiness");

test("pilot readiness fails closed when no evidence is supplied", () => {
  const result = buildPilotReadiness();

  assert.equal(result.readyForPilot, false);
  assert.deepEqual(
    Object.keys(result.checks),
    [...REQUIRED_PILOT_CHECKS]
  );
  assert.ok(Object.values(result.checks).every((value) => value === false));
});

test("pilot readiness requires every release gate to be explicitly true", () => {
  const evidence = Object.fromEntries(
    REQUIRED_PILOT_CHECKS.map((key) => [key, true])
  );

  assert.equal(buildPilotReadiness(evidence).readyForPilot, true);

  for (const missingCheck of REQUIRED_PILOT_CHECKS) {
    const incompleteEvidence = { ...evidence, [missingCheck]: false };
    const result = buildPilotReadiness(incompleteEvidence);

    assert.equal(result.readyForPilot, false, `Expected ${missingCheck} to block readiness`);
    assert.equal(result.checks[missingCheck], false);
  }
});

test("truthy values and unrelated fields cannot satisfy a pilot release gate", () => {
  const evidence = Object.fromEntries(
    REQUIRED_PILOT_CHECKS.map((key) => [key, true])
  );

  for (const value of ["true", 1, "yes", {}, null, undefined]) {
    assert.equal(
      buildPilotReadiness({ ...evidence, staffHandoffTested: value }).readyForPilot,
      false
    );
  }

  const { staffHandoffTested, ...withoutHandoff } = evidence;
  assert.equal(
    buildPilotReadiness({ ...withoutHandoff, unrelatedApproval: true }).readyForPilot,
    false
  );
});
