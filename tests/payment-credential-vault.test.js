"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { validateWebhookSecret, createPaymentWebhookSecretVault } = require("../payment-credential-vault");

const key = crypto.randomBytes(32).toString("base64");

test("encrypts and decrypts a hotel payment webhook secret", () => {
  const vault = createPaymentWebhookSecretVault(key);
  const encrypted = vault.encrypt("provider_webhook_secret_123");
  assert.notEqual(encrypted, "provider_webhook_secret_123");
  assert.equal(vault.decrypt(encrypted), "provider_webhook_secret_123");
});

test("fails closed when the dedicated encryption key is not configured", () => {
  const vault = createPaymentWebhookSecretVault("");
  assert.equal(vault.configured, false);
  assert.throws(() => vault.encrypt("provider_webhook_secret_123"), /PAYMENT_WEBHOOK_ENCRYPTION_KEY/);
  assert.throws(() => vault.decrypt("invalid"), /encryption key is unavailable/);
});

test("rejects short, oversized and whitespace-padded secrets", () => {
  for (const value of ["short", " provider_webhook_secret_123", "provider_webhook_secret_123 ", "x".repeat(513), "a\nbbbbbbbbbbbbbbbbb"]) {
    assert.throws(() => validateWebhookSecret(value));
  }
});

test("authenticated encryption rejects tampered ciphertext", () => {
  const vault = createPaymentWebhookSecretVault(key);
  const encrypted = vault.encrypt("provider_webhook_secret_123");
  const parts = encrypted.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  assert.throws(() => vault.decrypt(parts.join(".")));
});
