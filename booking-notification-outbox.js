"use strict";

const MAX_ATTEMPTS = 8;
const MAX_BATCH = 20;
const LEASE_SECONDS = 60;

async function enqueueBookingNotification(db, organizationId, bookingId) {
  if (!db || typeof db.query !== "function" || !organizationId || !bookingId) {
    throw new TypeError("Notification queue requires a database, hotel and booking.");
  }
  const result = await db.query(
    "INSERT INTO staff_booking_notification_outbox(organization_id,booking_id,event_type) VALUES($1,$2,'booking_requested') ON CONFLICT(organization_id,booking_id,event_type) DO NOTHING RETURNING id,status",
    [organizationId, bookingId]
  );
  return { enqueued: Boolean(result.rowCount), notification: result.rows[0] || null };
}

async function claimNext(db, organizationId) {
  const result = await db.query(
    "WITH candidate AS (SELECT id FROM staff_booking_notification_outbox WHERE attempts < $1 AND ($3::uuid IS NULL OR organization_id=$3) AND ((status='pending' AND next_attempt_at<=now()) OR (status='processing' AND lease_expires_at<now())) ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE staff_booking_notification_outbox o SET status='processing',attempts=o.attempts+1,last_attempt_at=now(),lease_expires_at=now()+($2 * interval '1 second'),updated_at=now() FROM candidate c WHERE o.id=c.id RETURNING o.id,o.organization_id,o.booking_id,o.attempts",
    [MAX_ATTEMPTS, LEASE_SECONDS, organizationId || null]
  );
  return result.rows[0] || null;
}

async function processBookingNotificationOutbox({ db, deliver, batchSize = 5, organizationId }) {
  if (!db || typeof db.query !== "function" || typeof deliver !== "function") {
    throw new TypeError("Notification processing requires a database and delivery function.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
    throw new RangeError("Notification batch size must be between 1 and 20.");
  }

  const results = [];
  for (let i = 0; i < batchSize; i += 1) {
    const job = await claimNext(db, organizationId);
    if (!job) break;
    let delivery;
    try {
      delivery = await deliver(job);
    } catch {
      delivery = { delivered: false, status: "failed" };
    }

    if (delivery?.delivered === true) {
      await db.query(
        "UPDATE staff_booking_notification_outbox SET status='delivered',delivered_at=now(),lease_expires_at=NULL,last_error_code='',updated_at=now() WHERE id=$1 AND status='processing'",
        [job.id]
      );
      results.push({ id: job.id, status: "delivered", attempts: job.attempts });
      continue;
    }

    const exhausted = job.attempts >= MAX_ATTEMPTS;
    const delaySeconds = Math.min(21600, 60 * (2 ** Math.min(job.attempts - 1, 9)));
    const errorCode = delivery?.status === "not_configured" ? "webhook_not_configured" : "webhook_delivery_failed";
    await db.query(
      "UPDATE staff_booking_notification_outbox SET status=$2,next_attempt_at=now()+($3 * interval '1 second'),lease_expires_at=NULL,last_error_code=$4,updated_at=now() WHERE id=$1 AND status='processing'",
      [job.id, exhausted ? "dead_letter" : "pending", delaySeconds, errorCode]
    );
    results.push({ id: job.id, status: exhausted ? "dead_letter" : "pending", attempts: job.attempts, retryInSeconds: exhausted ? null : delaySeconds });
  }
  return { processed: results.length, results };
}

async function getBookingNotificationHealth(db, organizationId) {
  const result = await db.query(
    "SELECT count(*) FILTER(WHERE status='pending')::int AS pending,count(*) FILTER(WHERE status='processing')::int AS processing,count(*) FILTER(WHERE status='delivered')::int AS delivered,count(*) FILTER(WHERE status='dead_letter')::int AS failed,max(last_attempt_at) AS last_attempt_at FROM staff_booking_notification_outbox WHERE organization_id=$1",
    [organizationId]
  );
  return result.rows[0] || { pending: 0, processing: 0, delivered: 0, failed: 0, last_attempt_at: null };
}

module.exports = { MAX_ATTEMPTS, enqueueBookingNotification, processBookingNotificationOutbox, getBookingNotificationHealth };
