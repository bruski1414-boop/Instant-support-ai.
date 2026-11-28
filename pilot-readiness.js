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

const BACKUP_EVIDENCE_MAX_AGE_DAYS = 90;

function hasCurrentBackupEvidence(evidence, now = new Date()) {
  if (evidence.durableBackupsVerified !== true) return false;
  if (typeof evidence.backupRestoreEvidenceRef !== "string" || !evidence.backupRestoreEvidenceRef.trim()) return false;
  if (typeof evidence.backupRestoreVerifiedAt !== "string") return false;

  const timestamp = evidence.backupRestoreVerifiedAt;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) return false;

  const verifiedAt = Date.parse(timestamp);
  const currentTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(currentTime)) return false;
  if (new Date(verifiedAt).toISOString() !== timestamp) return false;

  const ageMs = currentTime - verifiedAt;
  const maxAgeMs = BACKUP_EVIDENCE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function buildPilotReadiness(evidence = {}, now = new Date()) {
  const checks = Object.fromEntries(
    REQUIRED_PILOT_CHECKS.map((key) => [
      key,
      key === "durableBackupsVerified"
        ? hasCurrentBackupEvidence(evidence, now)
        : evidence[key] === true,
    ])
  );
  return {
    readyForPilot: Object.values(checks).every(Boolean),
    checks,
  };
}

module.exports = {
  BACKUP_EVIDENCE_MAX_AGE_DAYS,
  REQUIRED_PILOT_CHECKS,
  buildPilotReadiness,
  hasCurrentBackupEvidence,
};
