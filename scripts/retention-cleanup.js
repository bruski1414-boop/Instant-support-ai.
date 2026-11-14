const { Pool } = require("pg");
const { isRetentionApplyAuthorized, runRetentionCleanup } = require("../retention-cleanup");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const apply = isRetentionApplyAuthorized(process.argv.slice(2), process.env);
  if (process.argv.includes("--apply") && !apply) {
    throw new Error("Deletion requires both --apply and RETENTION_CLEANUP_ENABLED=true.");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 5000
  });
  try {
    const results = await runRetentionCleanup(pool, apply);
    const summary = {
      mode: apply ? "apply" : "dry-run",
      tenantsWithApprovedRetentionPolicy: results.length,
      totalEligible: results.reduce((sum, item) => sum + item.eligible, 0),
      totalDeleted: results.reduce((sum, item) => sum + item.deleted, 0),
      tenants: results
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write("Retention cleanup failed: " + error.message + "\n");
  process.exitCode = 1;
});
