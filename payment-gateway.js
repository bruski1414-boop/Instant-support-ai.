"use strict";

class PaymentGatewayError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "PaymentGatewayError";
    this.code = code;
    this.status = status;
  }
}

function validMoney(amountMinor, currency) {
  return Number.isSafeInteger(amountMinor) && amountMinor > 0 &&
    typeof currency === "string" && /^[A-Z]{3}$/.test(currency);
}

function validateBookingIntent(intent, now = Date.now()) {
  if (!intent || typeof intent !== "object" ||
      typeof intent.id !== "string" || !intent.id.trim() ||
      intent.status !== "awaiting_payment" ||
      !validMoney(intent.depositAmountMinor, intent.currency) ||
      !(intent.expiresAt instanceof Date) || !Number.isFinite(intent.expiresAt.getTime()) ||
      intent.expiresAt.getTime() <= now) {
    throw new PaymentGatewayError("BOOKING_NOT_PAYABLE", "Only an unexpired booking awaiting payment with a valid deposit can enter checkout.", 409);
  }
}

async function createCheckoutSession(adapter, intent, options = {}) {
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  validateBookingIntent(intent, now);
  if (!adapter || typeof adapter.createCheckoutSession !== "function") {
    throw new PaymentGatewayError("PAYMENT_PROVIDER_NOT_CONFIGURED", "A supported payment provider has not been configured.", 503);
  }
  let result;
  try {
    result = await adapter.createCheckoutSession(Object.freeze({
      bookingIntentId: intent.id,
      amountMinor: intent.depositAmountMinor,
      currency: intent.currency,
      idempotencyKey: intent.idempotencyKey,
      expiresAt: intent.expiresAt.toISOString(),
    }));
  } catch {
    throw new PaymentGatewayError("CHECKOUT_CREATION_FAILED", "The payment provider could not create checkout. No booking has been confirmed.", 502);
  }
  const checkoutUrl = typeof result?.checkoutUrl === "string" ? result.checkoutUrl : "";
  let parsedUrl;
  try { parsedUrl = new URL(checkoutUrl); } catch {}
  const providerReference = typeof result?.providerReference === "string" ? result.providerReference.trim() : "";
  const checkoutExpiresAt = result?.expiresAt instanceof Date ? result.expiresAt : new Date(result?.expiresAt);
  if (!parsedUrl || parsedUrl.protocol !== "https:" || !providerReference || providerReference.length > 200 ||
      !Number.isFinite(checkoutExpiresAt.getTime()) || checkoutExpiresAt.getTime() <= now ||
      checkoutExpiresAt.getTime() > intent.expiresAt.getTime() ||
      result.amountMinor !== intent.depositAmountMinor || result.currency !== intent.currency) {
    throw new PaymentGatewayError("INVALID_CHECKOUT_RESPONSE", "The payment provider returned checkout details that do not match the booking deposit.", 502);
  }
  return Object.freeze({
    checkoutUrl: parsedUrl.toString(),
    providerReference,
    amountMinor: intent.depositAmountMinor,
    currency: intent.currency,
    expiresAt: checkoutExpiresAt.toISOString(),
  });
}

async function verifyPaymentWebhook(adapter, input = {}) {
  if (!adapter || typeof adapter.verifyWebhook !== "function") {
    throw new PaymentGatewayError("PAYMENT_PROVIDER_NOT_CONFIGURED", "A supported payment provider has not been configured.", 503);
  }
  if (!Buffer.isBuffer(input.rawBody) || input.rawBody.length === 0 ||
      !input.headers || typeof input.headers !== "object") {
    throw new PaymentGatewayError("INVALID_WEBHOOK_INPUT", "The original webhook body and request headers are required.");
  }
  let event;
  try {
    event = await adapter.verifyWebhook({ rawBody: input.rawBody, headers: input.headers });
  } catch {
    throw new PaymentGatewayError("WEBHOOK_VERIFICATION_FAILED", "The payment notification could not be verified.", 401);
  }
  const eventId = typeof event?.eventId === "string" ? event.eventId.trim() : "";
  const providerReference = typeof event?.providerReference === "string" ? event.providerReference.trim() : "";
  const bookingIntentId = typeof event?.bookingIntentId === "string" ? event.bookingIntentId.trim() : "";
  const allowedStatuses = new Set(["succeeded", "failed", "cancelled", "pending"]);
  if (event?.signatureVerified !== true || !eventId || eventId.length > 200 ||
      !providerReference || providerReference.length > 200 ||
      !bookingIntentId || bookingIntentId.length > 100 ||
      typeof event.eventType !== "string" || !event.eventType.trim() || event.eventType.length > 120 ||
      !allowedStatuses.has(event.paymentStatus) ||
      !validMoney(event.amountMinor, event.currency)) {
    throw new PaymentGatewayError("UNTRUSTED_WEBHOOK_EVENT", "Only a complete, signature-verified payment event can be processed.", 401);
  }
  return Object.freeze({
    signatureVerified: true,
    eventId,
    eventType: event.eventType.trim(),
    paymentStatus: event.paymentStatus,
    providerReference,
    bookingIntentId,
    amountMinor: event.amountMinor,
    currency: event.currency,
  });
}

module.exports = {
  PaymentGatewayError,
  validateBookingIntent,
  createCheckoutSession,
  verifyPaymentWebhook,
};
