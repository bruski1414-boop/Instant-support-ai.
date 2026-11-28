const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_PILOT_CHECKS, buildPilotReadiness } = require("../pilot-readiness");

const NOW = new Date("2026-11-27T12:00:00.000Z");

function completeEvidence() {
  return {
    ...Object.fromEntries(REQUIRED_PILOT_CHECKS.map((key) => [key, true])),
    backupRestoreVerifiedAt: "2026-11-20T12:00:00.000Z",
    backupRestoreEvidenceRef: "internal-ops-record:restore-drill-2026-11-20",
  };
}

test("pilot readiness requires every declared check and current backup restore evidence", () => {
  const result = buildPilotReadiness(completeEvidence(), NOW);

  assert.equal(result.readyForPilot, true);
  assert.deepEqual(Object.keys(result.checks), [...REQUIRED_PILOT_CHECKS]);
  assert.ok(Object.values(result.checks).every((value) => value === true));
});

test("pilot readiness stays blocked when any single check is missing or false", () => {
  for (const missingKey of REQUIRED_PILOT_CHECKS) {
    const evidence = completeEvidence();
    delete evidence[missingKey];

    const result = buildPilotReadiness(evidence, NOW);
    assert.equal(result.readyForPilot, false, `missing ${missingKey} must block readiness`);
    assert.equal(result.checks[missingKey], false);
  }

  for (const falseKey of REQUIRED_PILOT_CHECKS) {
    const evidence = completeEvidence();
    evidence[falseKey] = false;

    const result = buildPilotReadiness(evidence, NOW);
    assert.equal(result.readyForPilot, false, `${falseKey}=false must block readiness`);
  }
});

test("backup flag alone is insufficient without a restore timestamp and evidence reference", () => {
  const evidence = completeEvidence();
  delete evidence.backupRestoreVerifiedAt;
  delete evidence.backupRestoreEvidenceRef;

  const result = buildPilotReadiness(evidence, NOW);
  assert.equal(result.readyForPilot, false);
  assert.equal(result.checks.durableBackupsVerified, false);
});

test("stale, future-dated, or invalid backup restore evidence blocks readiness", () => {
  for (const timestamp of [
    "2026-08-28T11:59:59.999Z",
    "2026-11-27T12:00:00.001Z",
    "not-a-date",
  ]) {
    const evidence = completeEvidence();
    evidence.backupRestoreVerifiedAt = timestamp;

    const result = buildPilotReadiness(evidence, NOW);
    assert.equal(result.readyForPilot, false, `${timestamp} must not qualify as current evidence`);
    assert.equal(result.checks.durableBackupsVerified, false);
  }
});

test("backup restore timestamps must use exact canonical UTC ISO-8601 format", () => {\n  for (const timestamp of [\n    "2026-11-20T12:00:00Z",\n    "2026-11-20T12:00:00.000+00:00",\n    "2026-11-20T13:00:00.000+01:00",\n    "2026-02-30T12:00:00.000Z",\n  ]) {\n    const evidence = completeEvidence();\n    evidence.backupRestoreVerifiedAt = timestamp;\n\n    const result = buildPilotReadiness(evidence, NOW);\n    assert.equal(result.readyForPilot, false, `${timestamp} must be rejected`);\n    assert.equal(result.checks.durableBackupsVerified, false);\n  }\n});\n\ntest("blank backup evidence references are rejected", () => {
  const evidence = completeEvidence();
  evidence.backupRestoreEvidenceRef = "   ";

  const result = buildPilotReadiness(evidence, NOW);
  assert.equal(result.readyForPilot, false);
  assert.equal(result.checks.durableBackupsVerified, false);
});

test("pilot readiness does not accept truthy strings or numbers as evidence", () => {
  const evidence = completeEvidence();
  evidence.durableBackupsVerified = "true";
  evidence.hotelPrivacyApproved = 1;

  const result = buildPilotReadiness(evidence, NOW);
  assert.equal(result.readyForPilot, false);
  assert.equal(result.checks.durableBackupsVerified, false);
  assert.equal(result.checks.hotelPrivacyApproved, false);
});

test("unknown evidence keys cannot replace required checks", () => {
  const result = buildPilotReadiness({ everythingVerified: true }, NOW);
  assert.equal(result.readyForPilot, false);
  assert.equal(Object.keys(result.checks).length, REQUIRED_PILOT_CHECKS.length);
});
