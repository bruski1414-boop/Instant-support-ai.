"use strict";

const { createTokenCipher } = require("./storage-security");

function validateWebhookSecret(value) {
  if (typeof value !== "string" || value.length < 16 || value.length > 512 ||
      value.trim() !== value || /[\r\n\0]/.test(value)) {
    throw new Error("Payment webhook secret must be a non-empty provider secret between 16 and 512 characters.");
  }
  return value;
}

function createPaymentWebhookSecretVault(keyText = process.env.PAYMENT_WEBHOOK_ENCRYPTION_KEY) {
  const cipher = createTokenCipher(keyText);
  return Object.freeze({
    configured: cipher.configured,
    encrypt(value) {
      if (!cipher.configured) throw new Error("PAYMENT_WEBHOOK_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
      return cipher.encrypt({ webhookSecret: validateWebhookSecret(value) });
    },
    decrypt(value) {
      if (!cipher.configured) throw new Error("Payment webhook encryption key is unavailable.");
      const result = cipher.decrypt(value);
      if (!result || typeof result !== "object" || Array.isArray(result) ||
          Object.keys(result).length !== 1 || typeof result.webhookSecret !== "string") {
        throw new Error("Stored payment webhook secret is invalid.");
      }
      return validateWebhookSecret(result.webhookSecret);
    },
  });
}

function validateConnectionInput({ db, organizationId, provider, vault }) {
  if (!db || typeof db.query !== "function" ||
      typeof organizationId !== "string" || !organizationId ||
      !/^[a-z][a-z0-9_-]{1,39}$/.test(provider || "") ||
      !vault || vault.configured !== true) {
    throw new Error("Payment connection storage is not configured.");
  }
}

async function savePaymentWebhookSecret({ db, organizationId, provider, secret, connectedBy = null, vault }) {
  validateConnectionInput({ db, organizationId, provider, vault });
  const encrypted = vault.encrypt(secret);
  await db.query(
    "INSERT INTO organization_payment_connections(organization_id,provider,encrypted_webhook_secret,status,connected_by,updated_at) VALUES($1,$2,$3,'configured',$4,now()) ON CONFLICT(organization_id,provider) DO UPDATE SET encrypted_webhook_secret=EXCLUDED.encrypted_webhook_secret,status='configured',connected_by=EXCLUDED.connected_by,updated_at=now()",
    [organizationId, provider, encrypted, connectedBy]
  );
  return { configured: true, provider };
}

async function loadPaymentWebhookSecret({ db, organizationId, provider, vault }) {
  validateConnectionInput({ db, organizationId, provider, vault });
  const result = await db.query(
    "SELECT encrypted_webhook_secret FROM organization_payment_connections WHERE organization_id=$1 AND provider=$2 AND status='configured'",
    [organizationId, provider]
  );
  if (!result.rowCount) return null;
  return vault.decrypt(result.rows[0].encrypted_webhook_secret);
}

async function disablePaymentWebhookConnection({ db, organizationId, provider, actorUserId = null, vault }) {
  validateConnectionInput({ db, organizationId, provider, vault });
  const result = await db.query(
    "UPDATE organization_payment_connections SET status='disabled',connected_by=$3,updated_at=now() WHERE organization_id=$1 AND provider=$2 AND status='configured' RETURNING provider",
    [organizationId, provider, actorUserId]
  );
  return { disabled: result.rowCount > 0, provider };
}

module.exports = {
  validateWebhookSecret,
  createPaymentWebhookSecretVault,
  savePaymentWebhookSecret,
  loadPaymentWebhookSecret,
  disablePaymentWebhookConnection,
};
