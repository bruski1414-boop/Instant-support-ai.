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

module.exports = { validateWebhookSecret, createPaymentWebhookSecretVault };
