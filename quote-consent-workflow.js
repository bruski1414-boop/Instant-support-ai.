"use strict";

const crypto = require("node:crypto");
const { PmsIntegrationError, validateDateRange } = require("./pms-integration");

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_MONEY_MINOR = Number.MAX_SAFE_INTEGER;

function requiredText(value, field, max = 500) {
  if (typeof value !== "string") throw new PmsIntegrationError("INVALID_QUOTE", field + " is required.");
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new PmsIntegrationError("INVALID_QUOTE", field + " is invalid.");
  }
  return text;
}

function money(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY_MINOR) {
    throw new PmsIntegrationError("INVALID_QUOTE", field + " must be a non-negative integer in minor currency units.");
  }
  return value;
}

function normalizeQuote(input, expected) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PmsIntegrationError("INVALID_PROVIDER_QUOTE", "The hotel provider returned no usable quote.", 502);
  }
  const dates = validateDateRange(input);
  const organizationId = requiredText(input.organizationId, "organizationId", 120);
  const roomTypeId = requiredText(input.roomTypeId, "roomTypeId", 120);
  const ratePlanId = requiredText(input.ratePlanId, "ratePlanId", 120);
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  const totalAmountMinor = money(input.totalAmountMinor, "totalAmountMinor");
  const taxesAmountMinor = money(input.taxesAmountMinor, "taxesAmountMinor");
  const feesAmountMinor = money(input.feesAmountMinor, "feesAmountMinor");
  const depositAmountMinor = money(input.depositAmountMinor, "depositAmountMinor");
  const cancellationPolicy = requiredText(input.cancellationPolicy, "cancellationPolicy", 2000);
  const quoteId = requiredText(input.quoteId, "quoteId", 160);
  const expiresAtMs = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : NaN;
  if (!/^[A-Z]{3}$/.test(currency) || totalAmountMinor <= 0 ||
      taxesAmountMinor + feesAmountMinor > totalAmountMinor ||
      depositAmountMinor > totalAmountMinor ||
      !Number.isSafeInteger(taxesAmountMinor + feesAmountMinor) ||
      !Number.isFinite(expiresAtMs)) {
    throw new PmsIntegrationError("INVALID_PROVIDER_QUOTE", "The hotel provider returned incomplete or inconsistent quote terms.", 502);
  }
  const normalized = {
    organizationId, checkIn: dates.checkIn, checkOut: dates.checkOut,
    roomTypeId, ratePlanId, currency, totalAmountMinor, taxesAmountMinor,
    feesAmountMinor, depositAmountMinor, cancellationPolicy, quoteId,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  for (const key of ["organizationId", "checkIn", "checkOut", "roomTypeId"]) {
    if (normalized[key] !== expected[key]) {
      throw new PmsIntegrationError("QUOTE_SCOPE_MISMATCH", "The returned quote does not match the requested hotel, dates or room.", 502);
    }
  }
  return Object.freeze(normalized);
}

function stableQuote(quote) {
  return JSON.stringify([
    quote.organizationId, quote.checkIn, quote.checkOut, quote.roomTypeId,
    quote.ratePlanId, quote.currency, quote.totalAmountMinor,
    quote.taxesAmountMinor, quote.feesAmountMinor, quote.depositAmountMinor,
    quote.cancellationPolicy, quote.quoteId, quote.expiresAt,
  ]);
}

function createQuoteWorkflow({ provider, organizationId, signingSecret, now = () => new Date() } = {}) {
  if (!provider || typeof provider.getQuote !== "function" ||
      typeof provider.createReservation !== "function" ||
      typeof provider.lookupReservationByIdempotencyKey !== "function") {
    throw new PmsIntegrationError("QUOTE_PROVIDER_INCOMPLETE", "The approved hotel adapter must support quotes, reservation writes and idempotency reconciliation.");
  }
  if (typeof organizationId !== "string" || !organizationId.trim() ||
      typeof signingSecret !== "string" || signingSecret.length < 32) {
    throw new PmsIntegrationError("QUOTE_WORKFLOW_CONFIG", "A hotel workspace and strong server-side quote signing secret are required.");
  }

  function currentTime() {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(ms)) throw new PmsIntegrationError("INVALID_CLOCK", "The quote workflow clock is invalid.");
    return ms;
  }
  function sign(encoded) {
    return crypto.createHmac("sha256", signingSecret).update(encoded).digest("base64url");
  }
  function decodeToken(token) {
    if (typeof token !== "string" || token.length > 12000) {
      throw new PmsIntegrationError("INVALID_QUOTE_TOKEN", "The quote token is invalid.");
    }
    const parts = token.split(".");
    if (parts.length !== 2) throw new PmsIntegrationError("INVALID_QUOTE_TOKEN", "The quote token is invalid.");
    const expected = Buffer.from(sign(parts[0]));
    const supplied = Buffer.from(parts[1]);
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      throw new PmsIntegrationError("INVALID_QUOTE_TOKEN", "The quote token signature is invalid.");
    }
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch {
      throw new PmsIntegrationError("INVALID_QUOTE_TOKEN", "The quote token payload is invalid.");
    }
    if (!payload || payload.organizationId !== organizationId ||
        !Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt) ||
        payload.expiresAt <= currentTime() || payload.expiresAt - payload.issuedAt > TOKEN_TTL_MS) {
      throw new PmsIntegrationError("QUOTE_EXPIRED", "This quote has expired. Request a fresh quote before continuing.", 409);
    }
    return payload;
  }

  return Object.freeze({
    async issue(input = {}) {
      const dates = validateDateRange(input);
      const expected = {
        organizationId,
        checkIn: dates.checkIn,
        checkOut: dates.checkOut,
        roomTypeId: requiredText(input.roomTypeId, "roomTypeId", 120),
      };
      const ratePlanId = requiredText(input.ratePlanId, "ratePlanId", 120);
      const occupancy = input.guestCount;
      if (!Number.isInteger(occupancy) || occupancy < 1 || occupancy > 20) {
        throw new PmsIntegrationError("INVALID_OCCUPANCY", "Guest count must be from 1 to 20.");
      }
      const raw = await provider.getQuote({
        ...expected, ratePlanId, guestCount: occupancy,
      }, { organizationId });
      const quote = normalizeQuote(raw, expected);
      if (quote.ratePlanId !== ratePlanId || Date.parse(quote.expiresAt) <= currentTime()) {
        throw new PmsIntegrationError("QUOTE_EXPIRED_OR_MISMATCHED", "The provider quote is expired or does not match the requested rate plan.", 409);
      }
      const issuedAt = currentTime();
      const expiresAt = Math.min(Date.parse(quote.expiresAt), issuedAt + TOKEN_TTL_MS);
      const payload = { organizationId, quote, guestCount: occupancy, issuedAt, expiresAt };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return Object.freeze({
        quote,
        quoteToken: encoded + "." + sign(encoded),
        tokenExpiresAt: new Date(expiresAt).toISOString(),
        requiresExplicitAcceptance: true,
      });
    },

    async confirm({ quoteToken, accepted, consentToShareDetails, guest, idempotencyKey } = {}) {
      if (accepted !== true) {
        throw new PmsIntegrationError("QUOTE_NOT_ACCEPTED", "The guest must explicitly accept the exact displayed quote and cancellation terms.", 409);
      }
      if (consentToShareDetails !== true) {
        throw new PmsIntegrationError("GUEST_CONSENT_REQUIRED", "The guest must explicitly consent to sharing their contact details with the hotel.", 409);
      }
      const payload = decodeToken(quoteToken);
      const key = requiredText(idempotencyKey, "idempotencyKey", 100);
      if (!/^[A-Za-z0-9_-]{12,100}$/.test(key)) {
        throw new PmsIntegrationError("INVALID_IDEMPOTENCY_KEY", "A valid stable idempotency key is required.");
      }
      const name = requiredText(guest && guest.name, "guest.name", 120);
      const phone = requiredText(guest && guest.phone, "guest.phone", 16);
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
        throw new PmsIntegrationError("INVALID_GUEST_PHONE", "Guest phone must use international format.");
      }

      const original = payload.quote;
      let fresh;
      try {
        const raw = await provider.getQuote({
          organizationId, checkIn: original.checkIn, checkOut: original.checkOut,
          roomTypeId: original.roomTypeId, ratePlanId: original.ratePlanId,
          guestCount: payload.guestCount,
        }, { organizationId });
        fresh = normalizeQuote(raw, original);
      } catch {
        return Object.freeze({ status: "staff_handoff", confirmed: false, reason: "quote_revalidation_failed" });
      }
      if (stableQuote(fresh) !== stableQuote(original) || Date.parse(fresh.expiresAt) <= currentTime()) {
        return Object.freeze({ status: "quote_changed", confirmed: false, reason: "fresh_quote_and_acceptance_required" });
      }

      let result;
      try {
        result = await provider.createReservation({
          organizationId, quoteId: original.quoteId, quote: original,
          guest: { name, phone }, idempotencyKey: key,
        }, { organizationId });
      } catch {
        // Resolve the original request key before any retry; never submit a second write here.
        try {
          const existing = await provider.lookupReservationByIdempotencyKey(key, { organizationId });
          if (existing && existing.organizationId === organizationId &&
              existing.status === "confirmed" &&
              typeof existing.bookingId === "string" && existing.bookingId.trim()) {
            return Object.freeze({ status: "confirmed", confirmed: true, bookingId: existing.bookingId.trim(), reconciled: true });
          }
          if (existing && existing.organizationId === organizationId && existing.status === "pending") {
            return Object.freeze({ status: "request_pending", confirmed: false, reason: "provider_write_pending" });
          }
        } catch { /* staff must reconcile through the PMS */ }
        return Object.freeze({ status: "staff_handoff", confirmed: false, reason: "write_outcome_uncertain" });
      }
      if (!result || result.organizationId !== organizationId) {
        return Object.freeze({ status: "staff_handoff", confirmed: false, reason: "unverified_provider_result" });
      }
      if (result.status !== "confirmed" || typeof result.bookingId !== "string" || !result.bookingId.trim()) {
        return Object.freeze({ status: "request_pending", confirmed: false, reason: "provider_has_not_confirmed" });
      }
      return Object.freeze({ status: "confirmed", confirmed: true, bookingId: result.bookingId.trim(), reconciled: false });
    },
  });
}

module.exports = { TOKEN_TTL_MS, normalizeQuote, createQuoteWorkflow };
