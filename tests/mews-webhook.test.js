"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyMewsWebhookUrlSecret, normalizeMewsGeneralWebhook } = require("../mews-webhook");

const enterpriseId = "11111111-1111-4111-8111-111111111111";
const integrationId = "22222222-2222-4222-8222-222222222222";
const reservationId = "33333333-3333-4333-8333-333333333333";
const secret = Buffer.alloc(32, 9).toString("base64url");

function body(events = [{ Discriminator: "ServiceOrderUpdated", Value: { Id: reservationId } }]) {
  return { EnterpriseId: enterpriseId, IntegrationId: integrationId, Events: events };
}

test("verifies Mews URL secrets using constant-time digest comparison", () => {
  assert.equal(verifyMewsWebhookUrlSecret(secret, secret), true);
  assert.equal(verifyMewsWebhookUrlSecret(secret, Buffer.alloc(32, 8).toString("base64url")), false);
  assert.equal(verifyMewsWebhookUrlSecret("short", secret), false);
  assert.equal(verifyMewsWebhookUrlSecret(secret, undefined), false);
});

test("normalizes Mews General Webhook service-order notifications to identifiers only", () => {
  const normalized = normalizeMewsGeneralWebhook(body(), integrationId);
  assert.equal(normalized.enterpriseId, enterpriseId);
  assert.equal(normalized.reservations.length, 1);
  assert.deepEqual(normalized.reservations[0], {
    enterpriseId, integrationId, discriminator: "ServiceOrderUpdated", entityId: reservationId
  });
  assert.equal(JSON.stringify(normalized).includes("guestEmail"), false);
});

test("ignores non-service-order event types without retaining their payload", () => {
  const normalized = normalizeMewsGeneralWebhook(body([
    { Discriminator: "CustomerUpdated", Value: { Id: reservationId, Email: "private@example.invalid" } },
    { Discriminator: "ServiceOrderUpdated", Value: { Id: reservationId } }
  ]), integrationId);
  assert.equal(normalized.ignoredCount, 1);
  assert.equal(normalized.reservations.length, 1);
  assert.equal(JSON.stringify(normalized).includes("private@example.invalid"), false);
});

test("rejects integration mismatch, malformed entity references and oversized batches", () => {
  assert.throws(() => normalizeMewsGeneralWebhook(body(), "44444444-4444-4444-8444-444444444444"), /integration/);
  assert.throws(() => normalizeMewsGeneralWebhook(body([{ Discriminator: "ServiceOrderUpdated", Value: { Id: "not-a-uuid" } }]), integrationId), /entity reference/);
  assert.throws(() => normalizeMewsGeneralWebhook(body([]), integrationId), /between 1 and 500/);
  assert.throws(() => normalizeMewsGeneralWebhook(null, integrationId), /must be an object/);
});
