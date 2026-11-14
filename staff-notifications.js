"use strict";

const crypto = require("node:crypto");

async function deliverStaffEscalation({
  organization,
  conversationId,
  reason,
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
    createdAt: new Date().toISOString()
  });
  const signature = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-veyra-signature": signature },
      body,
      signal: controller.signal
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

module.exports = { deliverStaffEscalation, shouldRetryStaffNotification };
