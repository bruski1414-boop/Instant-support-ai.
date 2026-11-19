"use strict";

require("dotenv").config();
const { Pool } = require("pg");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  try {
    const scrubbed = await pool.query(`
      WITH candidates AS (
        SELECT
          bi.id,
          (
            SELECT p.retention_days
            FROM organization_privacy_approvals p
            WHERE p.organization_id = bi.organization_id
            ORDER BY p.approved_at DESC
            LIMIT 1
          ) AS retention_days
        FROM booking_intents bi
        WHERE bi.guest_data_encrypted IS NOT NULL
      )
      UPDATE booking_intents bi
      SET
        status = CASE
          WHEN bi.status = 'awaiting_payment' AND bi.expires_at <= now() THEN 'expired'
          ELSE bi.status
        END,
        guest_data_encrypted = NULL,
        guest_data_purged_at = now(),
        updated_at = now()
      FROM candidates c
      WHERE bi.id = c.id
        AND (
          (bi.status = 'awaiting_payment' AND bi.expires_at <= now())
          OR (
            c.retention_days IS NOT NULL
            AND bi.created_at < now() - (c.retention_days * interval '1 day')
          )
        )
      RETURNING bi.id
    `);
    const quotes = await pool.query(`
      DELETE FROM pms_availability_quotes q
      WHERE q.expires_at < now() - interval '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM booking_intents bi WHERE bi.quote_id = q.id
        )
    `);
    process.stdout.write(JSON.stringify({
      guestRecordsScrubbed: scrubbed.rowCount,
      expiredQuotesDeleted: quotes.rowCount,
      completedAt: new Date().toISOString(),
    }) + "\n");
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write("Booking data cleanup failed: " + error.message + "\n");
  process.exitCode = 1;
});
