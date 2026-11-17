"use strict";

const { createCheckoutSession, verifyPaymentWebhook, PaymentGatewayError } = require("./payment-gateway");

class PaymentOrchestrationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "PaymentOrchestrationError";
    this.code = code;
    this.status = status;
  }
}

function createPaymentOrchestrator({ repository, adapter, providerName } = {}) {
  if (!repository || typeof repository.getBookingIntent !== "function" ||
      typeof repository.saveCheckout !== "function" ||
      typeof repository.applyVerifiedPaymentEvent !== "function") {
    throw new TypeError("A durable payment repository is required.");
  }
  const provider = typeof providerName === "string" ? providerName.trim() : "";
  return Object.freeze({
    async startCheckout({ organizationId, bookingIntentId }) {
      if (!provider || !adapter) {
        throw new PaymentGatewayError("PAYMENT_PROVIDER_NOT_CONFIGURED", "No payment provider is configured. No payment has been requested.", 503);
      }
      if (typeof organizationId !== "string" || !organizationId ||
          typeof bookingIntentId !== "string" || !bookingIntentId) {
        throw new PaymentOrchestrationError("INVALID_CHECKOUT_REQUEST", "A hotel and booking reference are required.", 400);
      }
      const intent = await repository.getBookingIntent({ organizationId, bookingIntentId });
      if (!intent) throw new PaymentOrchestrationError("BOOKING_NOT_FOUND", "Booking request not found.", 404);
      if (intent.paymentProvider && intent.paymentProvider !== provider) {
        throw new PaymentOrchestrationError("PAYMENT_PROVIDER_CONFLICT", "This booking is already associated with another payment provider.");
      }
      if (intent.paymentProviderReference) {
        if (!intent.checkoutUrl || !intent.checkoutExpiresAt || new Date(intent.checkoutExpiresAt).getTime() <= Date.now()) {
          throw new PaymentOrchestrationError("CHECKOUT_ALREADY_CREATED", "A checkout session already exists or expired. Staff review is required before creating another.");
        }
        return Object.freeze({
          checkoutUrl: intent.checkoutUrl,
          providerReference: intent.paymentProviderReference,
          amountMinor: intent.depositAmountMinor,
          currency: intent.currency,
          expiresAt: new Date(intent.checkoutExpiresAt).toISOString(),
          reused: true,
        });
      }
      const checkout = await createCheckoutSession(adapter, {
        id: intent.id,
        status: intent.status,
        depositAmountMinor: intent.depositAmountMinor,
        currency: intent.currency,
        idempotencyKey: intent.idempotencyKey,
        expiresAt: new Date(intent.expiresAt),
      });
      await repository.saveCheckout({
        organizationId, bookingIntentId, provider,
        providerReference: checkout.providerReference,
        checkoutUrl: checkout.checkoutUrl,
        checkoutExpiresAt: checkout.expiresAt,
        expectedAmountMinor: checkout.amountMinor,
        expectedCurrency: checkout.currency,
      });
      return Object.freeze({ ...checkout, reused: false });
    },

    async handleWebhook({ rawBody, headers }) {
      if (!provider || !adapter) {
        throw new PaymentGatewayError("PAYMENT_PROVIDER_NOT_CONFIGURED", "No payment provider is configured.", 503);
      }
      const event = await verifyPaymentWebhook(adapter, { rawBody, headers });
      const result = await repository.applyVerifiedPaymentEvent({
        provider,
        event,
      });
      if (!result || !["recorded", "duplicate", "ignored"].includes(result.status)) {
        throw new PaymentOrchestrationError("PAYMENT_EVENT_NOT_APPLIED", "The verified payment event could not be safely reconciled. Staff review is required.", 503);
      }
      return Object.freeze({ status: result.status, bookingIntentId: event.bookingIntentId });
    },
  });
}

module.exports = { PaymentOrchestrationError, createPaymentOrchestrator };
