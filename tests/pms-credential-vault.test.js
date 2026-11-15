"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPmsCredentialVault, validateCredentials } = require("../pms-credential-vault");

test("PMS credential vault encrypts credentials and decrypts only with the same key", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const vault = createPmsCredentialVault(key);
  const credentials = { clientId: "test-client", clientSecret: "private-secret", propertyCode: "HOTEL01" };
  const encrypted = vault.encrypt(credentials);
  assert.equal(vault.configured, true);
  assert.notEqual(encrypted, JSON.stringify(credentials));
  assert.equal(encrypted.includes("private-secret"), false);
  assert.deepEqual(vault.decrypt(encrypted), credentials);
  const otherVault = createPmsCredentialVault(Buffer.alloc(32, 8).toString("base64"));
  assert.throws(() => otherVault.decrypt(encrypted));
});

test("PMS credential vault refuses missing keys and unsupported credential fields", () => {
  const unavailable = createPmsCredentialVault("");
  assert.equal(unavailable.configured, false);
  assert.throws(() => unavailable.encrypt({ clientSecret: "secret" }), /PMS_CREDENTIAL_ENCRYPTION_KEY/);
  assert.throws(() => validateCredentials({ nested: { token: "secret" } }), /unsupported field/);
  assert.throws(() => validateCredentials({ "bad-key": "secret" }), /unsupported field/);
  assert.throws(() => validateCredentials({ clientSecret: "x".repeat(5000) }), /unsupported field/);
  assert.throws(() => validateCredentials({ clientSecret: "x".repeat(13000) }), /12 KB limit/);
});
