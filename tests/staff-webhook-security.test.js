"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  encryptWebhookConfig,
  decryptWebhookConfig,
  resolvePublicWebhook,
  isPublicAddress
} = require("../staff-webhook-security");

const key = Buffer.alloc(32, 7).toString("base64");

test("hotel webhook configuration is encrypted and round-trips with its dedicated key", () => {
  const config = { url: "https://hotel.example/webhook", secret: "hotel-secret" };
  const encrypted = encryptWebhookConfig(config, key);
  assert.notEqual(encrypted, JSON.stringify(config));
  assert.equal(encrypted.includes(config.secret), false);
  assert.deepEqual(decryptWebhookConfig(encrypted, key), config);
  assert.throws(() => decryptWebhookConfig(encrypted, Buffer.alloc(32, 8).toString("base64")));
});

test("webhook encryption refuses missing or incorrectly sized platform keys", () => {
  assert.throws(() => encryptWebhookConfig({ url: "https://example.com", secret: "x" }, ""));
  assert.throws(() => encryptWebhookConfig({ url: "https://example.com", secret: "x" }, Buffer.alloc(16).toString("base64")));
});

test("webhook URL validation requires HTTPS, a hostname and public DNS answers", async () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const valid = await resolvePublicWebhook("https://hotel.example/hooks/veyra", lookup);
  assert.equal(valid.url.hostname, "hotel.example");
  await assert.rejects(resolvePublicWebhook("http://hotel.example/hooks", lookup));
  await assert.rejects(resolvePublicWebhook("https://127.0.0.1/hooks", lookup));
  await assert.rejects(resolvePublicWebhook("https://localhost/hooks", lookup));
  await assert.rejects(resolvePublicWebhook("https://hotel.example/hooks", async () => [{ address: "10.0.0.8", family: 4 }]));
  await assert.rejects(resolvePublicWebhook("https://hotel.example/hooks", async () => [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.2", family: 4 }]));
});

test("public address validation rejects private, loopback and documentation ranges", () => {
  for (const address of ["10.0.0.1","127.0.0.1","169.254.1.1","172.16.0.1","192.168.1.1","192.0.2.4","::1","fc00::1","fe80::1","2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
});
