"use strict";

const { PmsIntegrationError } = require("./pms-integration");
const { recordVerifiedDeposit } = require("./booking-repository");

/**
 * Connects a provider-specific signature verifier to durable booking state.
 * The raw request body must be captured by the HTTP server before JSON parsing.
 * This layer deliberately stops at payment_verified; PMS orchestration must
 * separately load the tenant-scoped booking and persist the PMS outcome.
 */
async function processPaymentWebhook({
  verify,
  db,
  organizationId,
  provider,
  headers,
  rawBody,
  secret,
  receivedAt,
  recordDeposit = recordVerifiedDeposit,
}) {
  if (typeof verify !== "function" || !db ||
      typeof organizationId !== "string" || !organizationId ||
      !/^[a-z][a-z0-9_-]{1,39}$/.test(provider || "") ||
      !Buffer.isBuffer(rawBody) || typeof secret !== "string") {
    throw new PmsIntegrationError("PAYMENT_WEBHOOK_NOT_CONFIGURED", "Payment webhook processing is not configured.", 503);
  }

  // No database write is allowed until the provider signature and event mapper pass.
  const evidence = verify({ headers, rawBody, secret, receivedAt });
  if (!evidence || evidence.signatureVerified !== true) {
    throw new PmsIntegrationError("PAYMENT_WEBHOOK_NOT_VERIFIED", "Payment webhook could not be verified.", 401);
  }

  const result = await recordDeposit(db, organizationId, provider, evidence);
  return {
    accepted: result.accepted,
    duplicate: result.duplicate,
    state: result.state,
    bookingId: evidence.bookingId,
  };
}

module.exports = { processPaymentWebhook };
