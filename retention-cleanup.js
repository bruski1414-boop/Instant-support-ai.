const CURRENT_PRIVACY_POLICY_VERSION = "2026-11-14-v1";
const BATCH_LIMIT = 500;

function isRetentionApplyAuthorized(argv = [], env = process.env) {
  return argv.includes("--apply") && env.RETENTION_CLEANUP_ENABLED === "true";
}

async function countEligibleConversations(db, organizationId, retentionDays) {
  const result = await db.query(
    "SELECT count(*)::int AS eligible FROM conversations c WHERE c.organization_id=$1 AND c.status='resolved' AND c.last_message_at<now()-($2::int*interval '1 day') AND NOT EXISTS(SELECT 1 FROM escalations e WHERE e.conversation_id=c.id AND e.status<>'resolved')",
    [organizationId, retentionDays]
  );
  return result.rows[0].eligible;
}

async function cleanupTenantRetention(pool, organization, apply = false) {
  const eligible = await countEligibleConversations(pool, organization.id, organization.retention_days);
  if (!apply || eligible === 0) {
    return { organizationSlug: organization.slug, retentionDays: organization.retention_days, eligible, deleted: 0, remainingEligible: eligible, dryRun: !apply };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "WITH candidates AS MATERIALIZED (SELECT c.id FROM conversations c WHERE c.organization_id=$1 AND c.status='resolved' AND c.last_message_at<now()-($2::int*interval '1 day') AND NOT EXISTS(SELECT 1 FROM escalations e WHERE e.conversation_id=c.id AND e.status<>'resolved') ORDER BY c.last_message_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED), detached AS (UPDATE revenue_events re SET conversation_id=NULL,attribution_status='hotel_reported_unlinked' WHERE re.organization_id=$1 AND re.conversation_id IN (SELECT id FROM candidates) RETURNING re.id), deleted AS (DELETE FROM conversations c USING candidates x WHERE c.id=x.id AND c.organization_id=$1 RETURNING c.id) SELECT count(*)::int AS deleted FROM deleted",
      [organization.id, organization.retention_days, BATCH_LIMIT]
    );
    const deleted = result.rows[0].deleted;
    if (deleted > 0) {
      await client.query(
        "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id) VALUES($1,NULL,'retention.cleanup_scheduled','conversation_batch',$2)",
        [organization.id, String(deleted)]
      );
    }
    const remaining = await client.query(
      "SELECT count(*)::int AS eligible FROM conversations c WHERE c.organization_id=$1 AND c.status='resolved' AND c.last_message_at<now()-($2::int*interval '1 day') AND NOT EXISTS(SELECT 1 FROM escalations e WHERE e.conversation_id=c.id AND e.status<>'resolved')",
      [organization.id, organization.retention_days]
    );
    await client.query("COMMIT");
    return { organizationSlug: organization.slug, retentionDays: organization.retention_days, eligible, deleted, remainingEligible: remaining.rows[0].eligible, dryRun: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function runRetentionCleanup(pool, apply = false) {
  const tenants = await pool.query(
    "SELECT o.id,o.slug,s.conversation_retention_days AS retention_days FROM organizations o JOIN organization_settings s ON s.organization_id=o.id JOIN organization_privacy_approvals p ON p.organization_id=o.id WHERE s.conversation_retention_days>0 AND p.policy_version=$1 AND p.purpose_acknowledged=true AND p.retention_acknowledged=true AND p.backup_acknowledged=true AND p.access_acknowledged=true AND p.deletion_acknowledged=true AND p.revoked_at IS NULL ORDER BY o.slug",
    [CURRENT_PRIVACY_POLICY_VERSION]
  );
  const results = [];
  for (const organization of tenants.rows) {
    results.push(await cleanupTenantRetention(pool, organization, apply));
  }
  return results;
}

module.exports = {
  CURRENT_PRIVACY_POLICY_VERSION,
  BATCH_LIMIT,
  isRetentionApplyAuthorized,
  countEligibleConversations,
  cleanupTenantRetention,
  runRetentionCleanup
};
