"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_ORDER_UPDATED = "ServiceOrderUpdated";

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function verifyMewsWebhookUrlSecret(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" ||
      provided.length < 40 || provided.length > 128 ||
      expected.length < 40 || expected.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(provided) ||
      !/^[A-Za-z0-9_-]+$/.test(expected)) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

function normalizeMewsGeneralWebhook(input, expectedIntegrationId) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Mews webhook body must be an object.");
  }
  const enterpriseId = typeof input.EnterpriseId === "string" ? input.EnterpriseId : "";
  const integrationId = typeof input.IntegrationId === "string" ? input.IntegrationId : "";
  if (!UUID.test(enterpriseId) || !UUID.test(integrationId)) {
    throw new Error("Mews webhook enterprise and integration references must be UUIDs.");
  }
  if (typeof expectedIntegrationId !== "string" || !UUID.test(expectedIntegrationId) ||
      integrationId.toLowerCase() !== expectedIntegrationId.toLowerCase()) {
    throw new Error("Mews webhook integration does not match the configured integration.");
  }
  if (!Array.isArray(input.Events) || input.Events.length < 1 || input.Events.length > 500) {
    throw new Error("Mews webhook must contain between 1 and 500 events.");
  }

  const reservations = [];
  let ignoredCount = 0;
  for (const event of input.Events) {
    if (!event || typeof event !== "object" || Array.isArray(event) ||
        typeof event.Discriminator !== "string" || !event.Value || typeof event.Value !== "object" ||
        Array.isArray(event.Value)) {
      throw new Error("Mews webhook contains an invalid event.");
    }
    if (event.Discriminator !== SERVICE_ORDER_UPDATED) {
      ignoredCount += 1;
      continue;
    }
    const entityId = event.Value.Id;
    if (typeof entityId !== "string" || !UUID.test(entityId)) {
      throw new Error("Mews service-order event is missing a valid entity reference.");
    }
    reservations.push(Object.freeze({
      enterpriseId: enterpriseId.toLowerCase(),
      integrationId: integrationId.toLowerCase(),
      discriminator: SERVICE_ORDER_UPDATED,
      entityId: entityId.toLowerCase()
    }));
  }
  return Object.freeze({
    enterpriseId: enterpriseId.toLowerCase(),
    integrationId: integrationId.toLowerCase(),
    reservations: Object.freeze(reservations),
    ignoredCount
  });
}

module.exports = { verifyMewsWebhookUrlSecret, normalizeMewsGeneralWebhook };
