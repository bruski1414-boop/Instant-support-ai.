"use strict";

const { PmsIntegrationError } = require("./pms-integration");
const { recordVerifiedDeposit } = require("./booking-repository");
const { loadPaymentConnectionByEndpointToken } = require("./payment-credential-vault");

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


/**
 * Resolve the opaque endpoint token to a tenant and provider without accepting
 * either value from the webhook payload. A provider adapter must be explicitly
 * registered before any event can reach payment persistence.
 */
function createPaymentWebhookRequestHandler({ db, vault, providerVerifiers = {}, recordDeposit = recordVerifiedDeposit }) {
  return async function handlePaymentWebhookRequest({ endpointToken, headers, rawBody, receivedAt }) {
    try {
      const connection = await loadPaymentConnectionByEndpointToken({ db, endpointToken, vault });
      if (!connection) return { status: 404, body: { error: "Webhook endpoint not found." } };
      const verify = providerVerifiers[connection.provider];
      if (typeof verify !== "function") {
        return { status: 503, body: { error: "This payment provider is not enabled yet." } };
      }
      const result = await processPaymentWebhook({
        verify, db, organizationId: connection.organizationId,
        provider: connection.provider, headers, rawBody,
        secret: connection.secret, receivedAt, recordDeposit,
      });
      return { status: 200, body: { received: true, ...result } };
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 499
        ? error.status : 400;
      const safeCodes = new Set([
        "INVALID_PAYMENT_WEBHOOK_CONTEXT","INVALID_PAYMENT_WEBHOOK_TIMESTAMP",
        "STALE_PAYMENT_WEBHOOK","INVALID_PAYMENT_WEBHOOK_SIGNATURE",
        "INVALID_PAYMENT_WEBHOOK_BODY","INVALID_PAYMENT_WEBHOOK_EVENT",
        "INVALID_VERIFIED_PAYMENT_EVENT","PAYMENT_AMOUNT_MISMATCH",
        "BOOKING_NOT_FOUND","BOOKING_ALREADY_PAID","INVALID_BOOKING_PAYMENT_STATE",
      ]);
      const code = typeof error?.code === "string" && safeCodes.has(error.code)
        ? error.code : "PAYMENT_WEBHOOK_REJECTED";
      return { status, body: { error: "Payment webhook was rejected.", code } };
    }
  };
}

module.exports = { processPaymentWebhook, createPaymentWebhookRequestHandler };
