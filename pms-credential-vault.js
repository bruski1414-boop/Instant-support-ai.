"use strict";

const { createTokenCipher } = require("./storage-security");

function validateCredentials(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PMS credentials must be a plain object.");
  }
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 12 * 1024) {
    throw new Error("PMS credentials exceed the 12 KB limit.");
  }
  for (const [key, field] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
        !(typeof field === "string" || typeof field === "number" || typeof field === "boolean") ||
        (typeof field === "string" && field.length > 4096)) {
      throw new Error("PMS credentials contain an unsupported field.");
    }
  }
  return value;
}

function createPmsCredentialVault(keyText = process.env.PMS_CREDENTIAL_ENCRYPTION_KEY) {
  const cipher = createTokenCipher(keyText);
  return Object.freeze({
    configured: cipher.configured,
    encrypt(value) {
      return cipher.encrypt(validateCredentials(value));
    },
    decrypt(value) {
      const result = cipher.decrypt(value);
      return validateCredentials(result);
    },
  });
}

module.exports = { validateCredentials, createPmsCredentialVault };
