"use strict";

const crypto = require("node:crypto");
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
    throw new Error("Payment connection storage or PAYMENT_WEBHOOK_ENCRYPTION_KEY is not configured.");
  }
}

async function savePaymentWebhookSecret({ db, organizationId, provider, secret, connectedBy = null, vault }) {
  validateConnectionInput({ db, organizationId, provider, vault });
  const encrypted = vault.encrypt(secret);
  const endpointToken = crypto.randomBytes(32).toString("base64url");
  const endpointTokenHash = crypto.createHash("sha256").update(endpointToken).digest("hex");
  await db.query(
    "INSERT INTO organization_payment_connections(organization_id,provider,encrypted_webhook_secret,webhook_endpoint_token_hash,status,connected_by,connected_at,updated_at) VALUES($1,$2,$3,$4,'configured',$5,now(),now()) ON CONFLICT(organization_id,provider) DO UPDATE SET encrypted_webhook_secret=EXCLUDED.encrypted_webhook_secret,webhook_endpoint_token_hash=EXCLUDED.webhook_endpoint_token_hash,status='configured',connected_by=EXCLUDED.connected_by,connected_at=now(),updated_at=now()",
    [organizationId, provider, encrypted, endpointTokenHash, connectedBy]
  );
  return { configured: true, provider, endpointToken };
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


async function loadPaymentConnectionByEndpointToken({ db, endpointToken, vault }) {
  if (!db || typeof db.query !== "function" || typeof endpointToken !== "string" ||
      !/^[A-Za-z0-9_-]{40,60}$/.test(endpointToken) || !vault || vault.configured !== true) {
    return null;
  }
  const tokenHash = crypto.createHash("sha256").update(endpointToken).digest("hex");
  const result = await db.query(
    "SELECT organization_id,provider,encrypted_webhook_secret FROM organization_payment_connections WHERE webhook_endpoint_token_hash=$1 AND status='configured'",
    [tokenHash]
  );
  if (!result.rowCount) return null;
  return {
    organizationId: result.rows[0].organization_id,
    provider: result.rows[0].provider,
    secret: vault.decrypt(result.rows[0].encrypted_webhook_secret),
  };
}

module.exports = {
  validateWebhookSecret,
  createPaymentWebhookSecretVault,
  savePaymentWebhookSecret,
  loadPaymentWebhookSecret,
  loadPaymentConnectionByEndpointToken,
  disablePaymentWebhookConnection,
};
