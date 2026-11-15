"use strict";

require("dotenv").config();
const { Pool } = require("pg");
const { createStaffWebhookStore } = require("../staff-webhook-store");
const { deliverStaffEscalation, dispatchStaffNotification, retryPendingStaffNotifications } = require("../staff-notifications");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 5000
  });
  const webhookStore = createStaffWebhookStore({
    db,
    encryptionKey: process.env.STAFF_WEBHOOK_ENCRYPTION_KEY,
    allowedHosts: process.env.STAFF_WEBHOOK_ALLOWED_HOSTS
  });
  try {
    if (!webhookStore.encryptionConfigured) {
      throw new Error("STAFF_WEBHOOK_ENCRYPTION_KEY is required for notification retries.");
    }
    if (!webhookStore.allowedHostsConfigured) {
      throw new Error("STAFF_WEBHOOK_ALLOWED_HOSTS must contain an approved host for notification retries.");
    }
    const result = await retryPendingStaffNotifications({
      db,
      batchSize: 50,
      dispatch: async escalation => dispatchStaffNotification({
        db,
        organizationId: escalation.organization_id,
        escalationId: escalation.escalation_id,
        maxAttempts: 5,
        deliver: async () => {
          const connection = await webhookStore.resolve(escalation.organization_id);
          const delivery = connection && connection.verified ? connection : {};
          return deliverStaffEscalation({
            organization: {
              id: escalation.organization_id,
              name: escalation.organization_name,
              slug: escalation.organization_slug
            },
            conversationId: escalation.conversation_id,
            reason: escalation.reason,
            idempotencyKey: escalation.escalation_id,
            ...delivery
          });
        }
      })
    });
    const delivered = result.results.filter(item => item.delivered).length;
    const failed = result.results.filter(item => item.status === "failed").length;
    console.log(JSON.stringify({ scanned: result.scanned, delivered, failed }));
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error("Staff notification retry job failed:", error.message);
  process.exitCode = 1;
});
