"use strict";

const RESERVATION_STATES = new Set([
  "Inquired", "Confirmed", "Started", "Processed", "Canceled", "Optional", "Requested"
]);

function utc(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new Error(name + " is not a valid UTC timestamp.");
  }
  const date = new Date(value);
  const canonical = date.toISOString();
  const supplied = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (canonical !== supplied) throw new Error(name + " is not a real UTC timestamp.");
  return canonical;
}

function normalizeMewsReservationSnapshot(reservation, { expectedId, expectedServiceId } = {}) {
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    throw new Error("Mews reservation response is invalid.");
  }
  if (typeof reservation.id !== "string" || reservation.id.toLowerCase() !== String(expectedId).toLowerCase()) {
    throw new Error("Mews reservation identifier did not match the queued event.");
  }
  if (typeof reservation.serviceId !== "string" || reservation.serviceId.toLowerCase() !== String(expectedServiceId).toLowerCase()) {
    throw new Error("Mews reservation does not belong to the configured daily service.");
  }
  if (!RESERVATION_STATES.has(reservation.state)) {
    throw new Error("Mews reservation state is not supported.");
  }
  const scheduledStartUtc = utc(reservation.scheduledStartUtc, "scheduledStartUtc");
  const scheduledEndUtc = utc(reservation.scheduledEndUtc, "scheduledEndUtc");
  if (Date.parse(scheduledEndUtc) <= Date.parse(scheduledStartUtc)) {
    throw new Error("Mews reservation end must be later than its start.");
  }
  return Object.freeze({
    reservationId: reservation.id.toLowerCase(),
    serviceId: reservation.serviceId.toLowerCase(),
    state: reservation.state,
    scheduledStartUtc,
    scheduledEndUtc,
    updatedUtc: utc(reservation.updatedUtc, "updatedUtc")
  });
}

function retryDelayMs(attemptCount) {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) throw new Error("attemptCount must be a positive integer.");
  return Math.min(15 * 60 * 1000, 5000 * (2 ** Math.min(attemptCount - 1, 8)));
}

function createMewsInboxProcessor({ db, mewsStore, clock = () => new Date(), batchSize = 10, maxAttempts = 5, leaseMs = 120000 } = {}) {
  if (!db || typeof db.connect !== "function" || typeof db.query !== "function") throw new Error("A PostgreSQL pool is required.");
  if (!mewsStore || typeof mewsStore.resolve !== "function") throw new Error("A verified Mews connection store is required.");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("batchSize must be between 1 and 100.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("maxAttempts must be between 1 and 10.");
  if (!Number.isInteger(leaseMs) || leaseMs < 30000 || leaseMs > 600000) throw new Error("leaseMs must be between 30000 and 600000.");

  async function claimBatch() {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE mews_webhook_inbox SET status='failed',lease_expires_at=NULL,last_error='max_attempts_exhausted' WHERE status='processing' AND lease_expires_at<now() AND attempt_count >= $1",
        [maxAttempts]
      );
      const result = await client.query(
        "WITH candidates AS (SELECT id FROM mews_webhook_inbox WHERE attempt_count < $1 AND ((status='pending' AND next_attempt_at<=now()) OR (status='processing' AND lease_expires_at<now())) ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT $2) UPDATE mews_webhook_inbox AS inbox SET status='processing',attempt_count=inbox.attempt_count+1,lease_expires_at=now()+($3::text||' milliseconds')::interval,last_error='' FROM candidates WHERE inbox.id=candidates.id RETURNING inbox.id,inbox.organization_id,inbox.enterprise_id,inbox.entity_id,inbox.attempt_count",
        [maxAttempts, batchSize, leaseMs]
      );
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function markFailure(row) {
    const terminal = row.attempt_count >= maxAttempts;
    const nextAttempt = new Date(clock().getTime() + retryDelayMs(row.attempt_count));
    const updated = await db.query(
      "UPDATE mews_webhook_inbox SET status=$2,next_attempt_at=$3,lease_expires_at=NULL,last_error=$4 WHERE id=$1 AND status='processing' AND attempt_count=$5 AND lease_expires_at>now()",
      [row.id, terminal ? "failed" : "pending", nextAttempt, "reservation_fetch_failed", row.attempt_count]
    );
    if (!updated.rowCount) return "stale";
    return terminal ? "failed" : "retried";
  }

  async function processRow(row) {
    try {
      const connection = await mewsStore.resolve(row.organization_id);
      if (!connection || connection.propertyReference.toLowerCase() !== row.enterprise_id.toLowerCase()) {
        throw new Error("verified_property_mismatch");
      }
      const result = await connection.client.getReservations({
        enterpriseIds: [row.enterprise_id],
        reservationIds: [row.entity_id],
        count: 10
      });
      const matches = Array.isArray(result.reservations)
        ? result.reservations.filter((item) => typeof item?.id === "string" && item.id.toLowerCase() === row.entity_id.toLowerCase())
        : [];
      if (matches.length !== 1) throw new Error("reservation_not_found_or_ambiguous");
      const snapshot = normalizeMewsReservationSnapshot(matches[0], {
        expectedId: row.entity_id,
        expectedServiceId: connection.service.id
      });
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const ownership = await client.query(
          "SELECT id FROM mews_webhook_inbox WHERE id=$1 AND status='processing' AND attempt_count=$2 AND lease_expires_at>now() FOR UPDATE",
          [row.id, row.attempt_count]
        );
        if (!ownership.rowCount) {
          await client.query("ROLLBACK");
          return "stale";
        }
        await client.query(
          "INSERT INTO mews_reservation_snapshots(organization_id,enterprise_id,reservation_id,service_id,state,scheduled_start_utc,scheduled_end_utc,provider_updated_utc,fetched_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(organization_id,reservation_id) DO UPDATE SET enterprise_id=EXCLUDED.enterprise_id,service_id=EXCLUDED.service_id,state=EXCLUDED.state,scheduled_start_utc=EXCLUDED.scheduled_start_utc,scheduled_end_utc=EXCLUDED.scheduled_end_utc,provider_updated_utc=EXCLUDED.provider_updated_utc,fetched_at=now() WHERE mews_reservation_snapshots.provider_updated_utc<=EXCLUDED.provider_updated_utc",
          [row.organization_id,row.enterprise_id,snapshot.reservationId,snapshot.serviceId,snapshot.state,snapshot.scheduledStartUtc,snapshot.scheduledEndUtc,snapshot.updatedUtc]
        );
        await client.query(
          "UPDATE mews_webhook_inbox SET status='processed',processed_at=now(),lease_expires_at=NULL,last_error='' WHERE id=$1 AND status='processing' AND attempt_count=$2",
          [row.id, row.attempt_count]
        );
        await client.query("COMMIT");
        return "processed";
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch {
      return markFailure(row);
    }
  }

  async function processBatch() {
    const rows = await claimBatch();
    const outcomes = await Promise.all(rows.map(processRow));
    return Object.freeze({
      claimed: rows.length,
      processed: outcomes.filter((x) => x === "processed").length,
      retried: outcomes.filter((x) => x === "retried").length,
      failed: outcomes.filter((x) => x === "failed").length,
      stale: outcomes.filter((x) => x === "stale").length
    });
  }

  return Object.freeze({ processBatch });
}

module.exports = { createMewsInboxProcessor, normalizeMewsReservationSnapshot, retryDelayMs };
