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


function createPaymentWebhookRequestHandler({ db, vault, providerVerifiers = {}, recordDeposit = recordVerifiedDeposit, onVerifiedDeposit }) {
  return async function handlePaymentWebhookRequest({ endpointToken, headers, rawBody, receivedAt }) {
    try {
      const connection = await loadPaymentConnectionByEndpointToken({ db, endpointToken, vault });
      if (!connection) return { status: 404, body: { error: "Webhook endpoint not found." } };
      const hasVerifier = Object.prototype.hasOwnProperty.call(providerVerifiers, connection.provider);
      const verify = hasVerifier ? providerVerifiers[connection.provider] : null;
      if (typeof verify !== "function") return { status: 503, body: { error: "This payment provider is not enabled yet." } };
      const result = await processPaymentWebhook({
        verify, db, organizationId: connection.organizationId,
        provider: connection.provider, headers, rawBody,
        secret: connection.secret, receivedAt, recordDeposit,
      });
      // The callback receives only the tenant resolved from the secret endpoint
      // token and the booking ID from the verified provider event. It is safe to
      // retry for duplicate deliveries because the booking service has a
      // durable one-time PMS submission claim.
      if (typeof onVerifiedDeposit === "function" &&
          ["payment_verified", "booking_pending", "already_processed"].includes(result.state)) {
        const orchestration = await onVerifiedDeposit({
          organizationId: connection.organizationId,
          bookingId: result.bookingId,
          paymentProvider: connection.provider,
        });
        return { status: 200, body: { received: true, ...result, orchestration: orchestration || null } };
      }
      return { status: 200, body: { received: true, ...result } };
    } catch (error) {
      // Validation/signature failures are client errors. Unexpected database or
      // infrastructure failures must remain server errors so providers retry
      // delivery instead of treating a transient outage as a permanent rejection.
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 499
        ? error.status
        : Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599
          ? error.status
          : 500;
      const allowed = new Set(["INVALID_PAYMENT_WEBHOOK_CONTEXT","INVALID_PAYMENT_WEBHOOK_TIMESTAMP","STALE_PAYMENT_WEBHOOK","INVALID_PAYMENT_WEBHOOK_SIGNATURE","INVALID_PAYMENT_WEBHOOK_BODY","INVALID_PAYMENT_WEBHOOK_EVENT","INVALID_VERIFIED_PAYMENT_EVENT","PAYMENT_AMOUNT_MISMATCH","BOOKING_NOT_FOUND","BOOKING_ALREADY_PAID","INVALID_BOOKING_PAYMENT_STATE"]);
      const code = typeof error?.code === "string" && allowed.has(error.code) ? error.code : "PAYMENT_WEBHOOK_REJECTED";
      return { status, body: { error: status >= 500 ? "Payment webhook could not be processed." : "Payment webhook was rejected.", code } };
    }
  };
}

module.exports = { processPaymentWebhook, createPaymentWebhookRequestHandler };
