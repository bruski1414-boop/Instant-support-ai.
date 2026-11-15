"use strict";

const { postSignedWebhook } = require("./staff-webhook-security");

async function deliverStaffEscalation({
  organization,
  conversationId,
  reason,
  webhookConfig,
  postImpl = postSignedWebhook,
  timeoutMs = 5000
}) {
  if (!webhookConfig?.url || !webhookConfig?.secret) {
    return { configured: false, delivered: false, status: "not_configured" };
  }

  const event = {
    event: "veyra.escalation.created",
    organizationId: organization.id,
    organizationSlug: organization.slug,
    organization: organization.name,
    conversationId,
    reason,
    createdAt: new Date().toISOString()
  };

  try {
    const response = await postImpl(webhookConfig.url, webhookConfig.secret, event, { timeoutMs });
    return {
      configured: true,
      delivered: Boolean(response.ok),
      status: response.ok ? "delivered" : "failed"
    };
  } catch {
    return { configured: true, delivered: false, status: "failed" };
  }
}

module.exports = { deliverStaffEscalation };
