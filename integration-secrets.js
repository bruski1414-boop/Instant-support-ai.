"use strict";

const crypto = require("node:crypto");

function encryptionKeyFromEnv(env = process.env) {
  const encoded = String(env.TENANT_INTEGRATION_ENCRYPTION_KEY || "").trim();
  if (!encoded) return null;
  let key;
  try { key = Buffer.from(encoded, "base64"); } catch { return null; }
  return key.length === 32 && key.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "") ? key : null;
}

function encryptSecret(plaintext, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("A 32-byte encryption key is required.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSecret(record, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("A 32-byte encryption key is required.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = { encryptionKeyFromEnv, encryptSecret, decryptSecret };
