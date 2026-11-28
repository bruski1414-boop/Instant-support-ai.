"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { validateWebhookSecret, createPaymentWebhookSecretVault, savePaymentWebhookSecret, loadPaymentWebhookSecret, loadPaymentConnectionByEndpointToken, disablePaymentWebhookConnection } = require("../payment-credential-vault");

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

test("stores only encrypted secrets and scopes lookups to the hotel and provider", async () => {
  const vault = createPaymentWebhookSecretVault(key);
  const rows = new Map();
  const db = { async query(sql, params) {
    if (sql.startsWith("INSERT INTO organization_payment_connections")) {
      rows.set(params[0] + ":" + params[1], { encrypted_webhook_secret: params[2], webhook_endpoint_token_hash: params[3], status: "configured", organization_id: params[0], provider: params[1] });
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith("SELECT organization_id,provider,encrypted_webhook_secret")) {
      const row = [...rows.values()].find(x => x.webhook_endpoint_token_hash === params[0] && x.status === "configured");
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (sql.startsWith("SELECT encrypted_webhook_secret")) {
      const row = rows.get(params[0] + ":" + params[1]);
      return { rowCount: row?.status === "configured" ? 1 : 0, rows: row?.status === "configured" ? [row] : [] };
    }
    if (sql.startsWith("UPDATE organization_payment_connections")) {
      const row = rows.get(params[0] + ":" + params[1]);
      const wasConfigured = row?.status === "configured";
      if (wasConfigured) row.status = "disabled";
      return { rowCount: wasConfigured ? 1 : 0, rows: wasConfigured ? [{ provider: params[1] }] : [] };
    }
    throw new Error("Unexpected query");
  }};
  const savedA = await savePaymentWebhookSecret({ db, organizationId: "hotel-a", provider: "testpay", secret: "secret_for_hotel_a_123", vault });
  const savedB = await savePaymentWebhookSecret({ db, organizationId: "hotel-b", provider: "testpay", secret: "secret_for_hotel_b_123", vault });
  assert.notEqual(rows.get("hotel-a:testpay").encrypted_webhook_secret, "secret_for_hotel_a_123");
  assert.equal(await loadPaymentWebhookSecret({ db, organizationId: "hotel-a", provider: "testpay", vault }), "secret_for_hotel_a_123");
  assert.equal(await loadPaymentWebhookSecret({ db, organizationId: "hotel-b", provider: "testpay", vault }), "secret_for_hotel_b_123");
  assert.equal((await loadPaymentConnectionByEndpointToken({ db, endpointToken: savedA.endpointToken, vault })).organizationId, "hotel-a");
  assert.equal((await loadPaymentConnectionByEndpointToken({ db, endpointToken: savedB.endpointToken, vault })).secret, "secret_for_hotel_b_123");
  assert.notEqual(savedA.endpointToken, savedB.endpointToken);
  assert.notEqual(rows.get("hotel-a:testpay").webhook_endpoint_token_hash, savedA.endpointToken);
  const rotatedA = await savePaymentWebhookSecret({ db, organizationId: "hotel-a", provider: "testpay", secret: "rotated_secret_for_hotel_a_123", vault });
  assert.notEqual(rotatedA.endpointToken, savedA.endpointToken);
  assert.equal(await loadPaymentConnectionByEndpointToken({ db, endpointToken: savedA.endpointToken, vault }), null);
  assert.equal((await loadPaymentConnectionByEndpointToken({ db, endpointToken: rotatedA.endpointToken, vault })).secret, "rotated_secret_for_hotel_a_123");
  assert.equal(await loadPaymentConnectionByEndpointToken({ db, endpointToken: "unknown_endpoint_token_12345678901234567890", vault }), null);
  assert.equal(await loadPaymentWebhookSecret({ db, organizationId: "hotel-c", provider: "testpay", vault }), null);
  assert.deepEqual(await disablePaymentWebhookConnection({ db, organizationId: "hotel-a", provider: "testpay", vault }), { disabled: true, provider: "testpay" });
  assert.equal(await loadPaymentWebhookSecret({ db, organizationId: "hotel-a", provider: "testpay", vault }), null);
  assert.deepEqual(await disablePaymentWebhookConnection({ db, organizationId: "hotel-a", provider: "testpay", vault }), { disabled: false, provider: "testpay" });
});

test("refuses payment connection operations when encryption is unavailable", async () => {
  const vault = createPaymentWebhookSecretVault("");
  const db = { async query() { throw new Error("must not query database"); } };
  await assert.rejects(() => savePaymentWebhookSecret({ db, organizationId: "hotel-a", provider: "testpay", secret: "secret_for_hotel_a_123", vault }), /not configured/);
  await assert.rejects(() => loadPaymentWebhookSecret({ db, organizationId: "hotel-a", provider: "testpay", vault }), /not configured/);
});
