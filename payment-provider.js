"use strict";
const crypto = require("node:crypto");
const { PmsIntegrationError } = require("./pms-integration");

/**
 * Provider-neutral HMAC webhook verifier. Real provider adapters must supply
 * their documented signature scheme and event mapper; this is not a claim of
 * compatibility with Stripe, Adyen, or another specific payment provider.
 */
function createHmacPaymentWebhookVerifier(options = {}) {
  const signatureHeader = String(options.signatureHeader || "x-payment-signature").toLowerCase();
  const timestampHeader = String(options.timestampHeader || "x-payment-timestamp").toLowerCase();
  const prefix = typeof options.signaturePrefix === "string" ? options.signaturePrefix : "";
  const maxSkewSeconds = Number.isInteger(options.maxSkewSeconds) ? options.maxSkewSeconds : 300;
  const mapEvent = options.mapEvent;
  if (!/^[a-z0-9-]{1,80}$/.test(signatureHeader) ||
      !/^[a-z0-9-]{1,80}$/.test(timestampHeader) ||
      !Number.isInteger(maxSkewSeconds) || maxSkewSeconds < 30 || maxSkewSeconds > 600 ||
      typeof mapEvent !== "function") {
    throw new PmsIntegrationError("INVALID_PAYMENT_WEBHOOK_CONFIG", "Payment webhook verifier configuration is invalid.");
  }
  return ({ headers, rawBody, secret, receivedAt = new Date() }) => {
    if (!headers || !Buffer.isBuffer(rawBody) || rawBody.length > 64 * 1024 ||
        typeof secret !== "string" || secret.length < 16) {
      throw new PmsIntegrationError("INVALID_PAYMENT_WEBHOOK_CONTEXT", "Payment webhook verification context is incomplete.", 400);
    }
    const header = name => {
      const key = Object.keys(headers).find(k => k.toLowerCase() === name);
      return key ? String(headers[key]) : "";
    };
    const timestampText = header(timestampHeader);
    if (!/^\d{10}$/.test(timestampText)) {
      throw new PmsIntegrationError("INVALID_PAYMENT_WEBHOOK_TIMESTAMP", "Payment webhook timestamp is missing or invalid.", 401);
    }
    const timestamp = Number(timestampText);
    const nowMs = receivedAt instanceof Date ? receivedAt.getTime() : Date.parse(receivedAt);
    if (!Number.isFinite(nowMs) || Math.abs(Math.floor(nowMs / 1000) - timestamp) > maxSkewSeconds) {
      throw new PmsIntegrationError("STALE_PAYMENT_WEBHOOK", "Payment webhook timestamp is outside the accepted window.", 401);
    }
    const suppliedText = header(signatureHeader);
    if (!suppliedText.startsWith(prefix)) {
      throw new PmsIntegrationError("INVALID_PAYMENT_WEBHOOK_SIGNATURE", "Payment webhook signature is missing or invalid.", 401);
    }
    const supplied = suppliedText.slice(prefix.length);
    if (!/^[a-f0-9]{64}$/i.test(supplied)) {
      throw new PmsIntegrationError("INVALID_PAYMENT_WEBHOOK_SIGNATURE", "Payment webhook signature is missing or invalid.", 401);
    }
    const signed = Buffer.concat([Buffer.from(timestampText + ".", "utf8"), rawBody]);
    const expected = crypto.createHmac("sha256", secret).update(signed).digest();
    const actual = Buffer.from(supplied, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new PmsIntegrationError("INVALID_PAYMENT_WEBHOOK_SIGNATURE", "Payment webhook signature is invalid.", 401);
    }
    let parsed;
    try { parsed = JSON.parse(rawBody.toString("utf8")); }
    catch { throw new PmsIntegrationError("INVALID_PAYMENT_WEBHOOK_BODY", "Payment webhook body is not valid JSON.", 400); }
    let mapped;
    try { mapped = mapEvent(parsed); }
    catch { throw new PmsIntegrationError("INVALID_PAYMENT_WEBHOOK_EVENT", "Payment provider event could not be normalized.", 400); }
    if (!mapped || typeof mapped !== "object" || Array.isArray(mapped) ||
        typeof mapped.eventId !== "string" || !mapped.eventId.trim() ||
        typeof mapped.bookingId !== "string" || !mapped.bookingId.trim() ||
        typeof mapped.paymentId !== "string" || !mapped.paymentId.trim() ||
        !Number.isSafeInteger(mapped.amountMinor) || mapped.amountMinor <= 0 ||
        typeof mapped.currency !== "string" || !/^[A-Za-z]{3}$/.test(mapped.currency.trim()) ||
        !["succeeded", "failed", "pending"].includes(mapped.status)) {
      throw new PmsIntegrationError("INVALID_PAYMENT_WEBHOOK_EVENT", "Payment provider event fields are incomplete or invalid.", 400);
    }
    return {
      signatureVerified: true, eventId: mapped.eventId.trim(),
      bookingId: mapped.bookingId.trim(), paymentId: mapped.paymentId.trim(),
      amountMinor: mapped.amountMinor, currency: mapped.currency.trim().toUpperCase(),
      status: mapped.status,
    };
  };
}
module.exports = { createHmacPaymentWebhookVerifier };
