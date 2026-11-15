"use strict";

const crypto = require("node:crypto");

async function sendStaffIntegrationTest({ organization, webhookUrl, webhookSecret, fetchImpl = fetch, timeoutMs = 5000 }) {
  if (!webhookUrl || !webhookSecret) return { configured: false, verified: false };
  const event = { event: "veyra.integration.test", test: true, organizationId: organization.id, organizationSlug: organization.slug, organization: organization.name, idempotencyKey: "test-" + crypto.randomUUID(), createdAt: new Date().toISOString() };
  const body = JSON.stringify(event);
  const signature = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-veyra-signature": signature, "idempotency-key": event.idempotencyKey }, body, signal: controller.signal, redirect: "error" });
    return { configured: true, verified: Boolean(response.ok), status: response.ok ? "delivered" : "failed", event };
  } catch {
    return { configured: true, verified: false, status: "failed" };
  } finally {
    clearTimeout(timer);
  }
}
async function deliverStaffEscalation({
  organization,
  conversationId,
  reason,
  idempotencyKey,
  webhookUrl,
  webhookSecret,
  fetchImpl = fetch,
  timeoutMs = 5000
}) {
  if (!webhookUrl || !webhookSecret) {
    return { configured: false, delivered: false, status: "not_configured" };
  }
  const body = JSON.stringify({
    event: "veyra.escalation.created",
    organizationId: organization.id,
    organizationSlug: organization.slug,
    organization: organization.name,
    conversationId,
    reason,
    idempotencyKey: idempotencyKey || null,
    createdAt: new Date().toISOString()
  });
  const signature = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-veyra-signature": signature, ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body,
      signal: controller.signal,
      redirect: "error"
    });
    return { configured: true, delivered: Boolean(response.ok), status: response.ok ? "delivered" : "failed" };
  } catch {
    return { configured: true, delivered: false, status: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

function shouldRetryStaffNotification({ needsHuman, createdEscalation, notificationStatus, notificationAttempts }) {
  return Boolean(
    needsHuman &&
    !createdEscalation &&
    notificationStatus !== "delivered" &&
    Number.isInteger(Number(notificationAttempts)) &&
    Number(notificationAttempts) >= 0 &&
    Number(notificationAttempts) < 3
  );
}


/**
 * Claims an escalation notification atomically before calling the external
 * dispatcher. The database lease allows recovery after a crashed process.
 */
async function dispatchStaffNotification({ db, organizationId, escalationId, maxAttempts = 5, deliver }) {
  const claim = await db.query(
    "UPDATE escalations SET notification_status='sending',notification_attempts=notification_attempts+1,notification_last_attempt_at=now() WHERE id=$1 AND organization_id=$2 AND status<>'resolved' AND notification_status<>'delivered' AND notification_attempts<$3 AND (notification_status<>'sending' OR notification_last_attempt_at<now()-interval '2 minutes') RETURNING id",
    [escalationId, organizationId, maxAttempts]
  );
  if (!claim.rowCount) {
    const current = await db.query(
      "SELECT notification_status,notification_attempts FROM escalations WHERE id=$1 AND organization_id=$2",
      [escalationId, organizationId]
    );
    const status = current.rows[0]?.notification_status || "not_configured";
    return { claimed: false, status, configured: status !== "not_configured", delivered: status === "delivered" };
  }
  let result;
  try {
    result = await deliver();
  } catch {
    result = { configured: true, delivered: false, status: "failed" };
  }
  await db.query(
    "UPDATE escalations SET notification_status=$1,notification_attempts=notification_attempts-CASE WHEN $2 THEN 0 ELSE 1 END WHERE id=$3 AND organization_id=$4 AND notification_status='sending'",
    [result.status, result.configured, escalationId, organizationId]
  );
  return { ...result, claimed: true };
}


/**
 * Retry a bounded batch of failed or abandoned staff notifications.
 * The dispatcher still performs the atomic per-escalation lease claim, so
 * overlapping invocations cannot send the same escalation concurrently.
 */
async function retryPendingStaffNotifications({ db, dispatch, batchSize = 50 }) {
  if (!db || typeof db.query !== "function") throw new TypeError("A database client is required.");
  if (typeof dispatch !== "function") throw new TypeError("A notification dispatcher is required.");
  const limit = Number.isInteger(batchSize) ? Math.max(1, Math.min(batchSize, 100)) : 50;
  const pending = await db.query(
    "SELECT e.id AS escalation_id,e.organization_id,e.conversation_id,e.reason,o.name AS organization_name,o.slug AS organization_slug FROM escalations e JOIN organizations o ON o.id=e.organization_id WHERE e.status<>'resolved' AND e.notification_attempts<5 AND ((e.notification_status='failed' AND (e.notification_last_attempt_at IS NULL OR e.notification_last_attempt_at<now()-interval '5 minutes')) OR (e.notification_status='sending' AND e.notification_last_attempt_at<now()-interval '2 minutes')) ORDER BY COALESCE(e.notification_last_attempt_at,e.created_at),e.created_at LIMIT $1",
    [limit]
  );
  const results = [];
  for (const escalation of pending.rows) {
    try {
      results.push(await dispatch(escalation));
    } catch {
      results.push({ claimed: false, status: "failed", delivered: false, configured: true });
    }
  }
  return { scanned: pending.rows.length, results };
}

module.exports = { sendStaffIntegrationTest, deliverStaffEscalation, shouldRetryStaffNotification, dispatchStaffNotification, retryPendingStaffNotifications };
