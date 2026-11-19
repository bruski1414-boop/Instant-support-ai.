"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { createMewsInboxProcessor } = require("../mews-inbox-processor");

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("TEST_DATABASE_URL is required for Mews PostgreSQL integration tests.");
  process.exit(1);
}

const schema = "mews_it_" + randomUUID().replace(/-/g, "");
const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === "false" ? false : undefined,
  options: "-c search_path=" + schema + ",public",
  max: 8
});
const ids = {
  organization: randomUUID(),
  enterprise: randomUUID(),
  reservation: randomUUID(),
  service: randomUUID()
};
const reservation = (updatedUtc) => ({
  id: ids.reservation,
  serviceId: ids.service,
  state: "Confirmed",
  scheduledStartUtc: "2026-12-01T15:00:00Z",
  scheduledEndUtc: "2026-12-03T11:00:00Z",
  updatedUtc,
  guestName: "Must not persist",
  guestEmail: "private@example.invalid"
});

async function main() {
  await pool.query("CREATE SCHEMA " + schema);
  await pool.query(`
    CREATE TABLE mews_webhook_inbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      integration_id TEXT NOT NULL,
      enterprise_id TEXT NOT NULL,
      discriminator TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','processed','failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lease_expires_at TIMESTAMPTZ,
      last_error TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX mews_webhook_inbox_active_event_unique_idx
      ON mews_webhook_inbox(organization_id,integration_id,enterprise_id,discriminator,entity_id)
      WHERE status IN ('pending','processing');
    CREATE TABLE mews_reservation_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      enterprise_id TEXT NOT NULL,
      reservation_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      state TEXT NOT NULL,
      scheduled_start_utc TIMESTAMPTZ NOT NULL,
      scheduled_end_utc TIMESTAMPTZ NOT NULL,
      provider_updated_utc TIMESTAMPTZ NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(organization_id,reservation_id)
    );
  `);

  const inserted = await pool.query(
    "INSERT INTO mews_webhook_inbox(organization_id,integration_id,enterprise_id,discriminator,entity_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
    [ids.organization, randomUUID(), ids.enterprise, "ServiceOrderUpdated", ids.reservation]
  );
  const inboxId = inserted.rows[0].id;

  const duplicateEntity = randomUUID();
  const duplicateParams = [ids.organization, randomUUID(), ids.enterprise, "ServiceOrderUpdated", duplicateEntity];
  const insertEvent = "INSERT INTO mews_webhook_inbox(organization_id,integration_id,enterprise_id,discriminator,entity_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,integration_id,enterprise_id,discriminator,entity_id) WHERE status IN ('pending','processing') DO NOTHING RETURNING id";
  const firstDelivery = await pool.query(insertEvent, duplicateParams);
  assert.equal(firstDelivery.rowCount, 1);
  const duplicatePending = await pool.query(insertEvent, duplicateParams);
  assert.equal(duplicatePending.rowCount, 0, "duplicate pending delivery must be coalesced");
  await pool.query("UPDATE mews_webhook_inbox SET status='processing' WHERE id=$1", [firstDelivery.rows[0].id]);
  const duplicateProcessing = await pool.query(insertEvent, duplicateParams);
  assert.equal(duplicateProcessing.rowCount, 0, "duplicate processing delivery must be coalesced");
  await pool.query("UPDATE mews_webhook_inbox SET status='processed' WHERE id=$1", [firstDelivery.rows[0].id]);
  const laterUpdate = await pool.query(insertEvent, duplicateParams);
  assert.equal(laterUpdate.rowCount, 1, "later event after processing must be allowed through");
  await pool.query("UPDATE mews_webhook_inbox SET status='processed' WHERE id=$1", [laterUpdate.rows[0].id]);

  let releaseFirstFetch;
  let firstFetchStarted;
  const firstStarted = new Promise((resolve) => { firstFetchStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirstFetch = resolve; });

  const store = (fetchReservations) => ({
    async resolve() {
      return {
        propertyReference: ids.enterprise,
        service: { id: ids.service },
        client: { getReservations: fetchReservations }
      };
    }
  });
  const first = createMewsInboxProcessor({
    db: pool,
    mewsStore: store(async () => {
      firstFetchStarted();
      await firstGate;
      return { reservations: [reservation("2026-11-16T10:00:00Z")] };
    }),
    leaseMs: 30000
  });

  const firstRun = first.processBatch();
  await firstStarted;

  const competing = createMewsInboxProcessor({
    db: pool,
    mewsStore: store(async () => ({ reservations: [reservation("2026-11-16T11:00:00Z")] })),
    leaseMs: 30000
  });
  const blocked = await competing.processBatch();
  assert.equal(blocked.claimed, 0, "SKIP LOCKED claim must not take a live lease");

  await pool.query(
    "UPDATE mews_webhook_inbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [inboxId]
  );
  const reclaimed = await competing.processBatch();
  assert.deepEqual(reclaimed, { claimed: 1, processed: 1, retried: 0, failed: 0, stale: 0 });

  releaseFirstFetch();
  const stale = await firstRun;
  assert.deepEqual(stale, { claimed: 1, processed: 0, retried: 0, failed: 0, stale: 1 });

  const finalInbox = await pool.query(
    "SELECT status,attempt_count FROM mews_webhook_inbox WHERE id=$1",
    [inboxId]
  );
  assert.equal(finalInbox.rows[0].status, "processed");
  assert.equal(Number(finalInbox.rows[0].attempt_count), 2);

  const snapshots = await pool.query(
    "SELECT provider_updated_utc::text FROM mews_reservation_snapshots WHERE organization_id=$1 AND reservation_id=$2",
    [ids.organization, ids.reservation]
  );
  assert.equal(snapshots.rowCount, 1);
  assert.match(snapshots.rows[0].provider_updated_utc, /11:00:00/);

  const piiColumns = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='mews_reservation_snapshots' AND column_name IN ('guest_name','guest_email','guest_phone','notes')",
    [schema]
  );
  assert.equal(piiColumns.rowCount, 0, "reservation snapshot schema must not contain guest PII columns");

  console.log("PASS: PostgreSQL lease contention, expired-lease reclaim, stale-worker fencing and PII-minimal snapshot persistence.");
}

main().catch((error) => {
  console.error("Mews PostgreSQL integration failed:", error.message);
  process.exitCode = 1;
}).finally(async () => {
  await pool.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => {});
  await pool.end();
});
