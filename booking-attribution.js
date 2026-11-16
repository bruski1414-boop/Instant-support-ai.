"use strict";

const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/i;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DEFAULT_ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_ATTRIBUTION_WINDOW_MS = 5 * 60 * 1000;
const SUPPORTED_CURRENCIES = new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : ["EUR", "USD", "GBP", "THB", "AED", "JPY"]);

function requiredUuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(field + " must be a valid UUID.");
  return value.toLowerCase();
}

function requiredString(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.split("").some(ch => ch.charCodeAt(0) < 32)) {
    throw new Error(field + " is required and must be a valid string.");
  }
  return value.trim();
}

function normalizeUtcTimestamp(value, field) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) throw new Error(field + " must be an ISO-8601 UTC timestamp.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(field + " must be a valid timestamp.");
  const canonical = new Date(parsed).toISOString();
  const supplied = value.includes(".")
    ? value.replace(/(\.\d{1,2})Z$/, match => match.slice(0, -1).padEnd(4, "0") + "Z")
    : value.replace("Z", ".000Z");
  if (canonical !== supplied) throw new Error(field + " must be a real UTC calendar timestamp.");
  return canonical;
}

function hashBookingAttributionToken(token) {
  if (typeof token !== "string" || !TOKEN.test(token)) throw new Error("A valid 256-bit booking attribution token is required.");
  const decoded = Buffer.from(token, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== token) {
    throw new Error("A valid canonical 256-bit base64url booking attribution token is required.");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function issueBookingAttributionIntent({
  organizationId,
  conversationId,
  issuedAt = new Date().toISOString(),
  ttlMs = DEFAULT_ATTRIBUTION_WINDOW_MS,
  tokenFactory = () => randomBytes(32).toString("base64url")
} = {}) {
  const safeOrganizationId = requiredUuid(organizationId, "organizationId");
  const safeConversationId = requiredUuid(conversationId, "conversationId");
  const safeIssuedAt = normalizeUtcTimestamp(issuedAt, "issuedAt");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_ATTRIBUTION_WINDOW_MS || ttlMs > DEFAULT_ATTRIBUTION_WINDOW_MS) {
    throw new Error("ttlMs must be between five minutes and 30 days.");
  }
  if (typeof tokenFactory !== "function") throw new Error("tokenFactory must be a function.");
  const oneTimeToken = tokenFactory();
  const tokenHash = hashBookingAttributionToken(oneTimeToken);
  const expiresAt = new Date(Date.parse(safeIssuedAt) + ttlMs).toISOString();
  return Object.freeze({
    oneTimeToken,
    record: Object.freeze({
      schemaVersion: 1,
      organizationId: safeOrganizationId,
      conversationId: safeConversationId,
      tokenHash,
      issuedAt: safeIssuedAt,
      expiresAt,
      consumedAt: null
    })
  });
}

function normalizeBookingAttributionIntent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A booking attribution intent record is required.");
  const organizationId = requiredUuid(input.organizationId, "organizationId");
  const conversationId = requiredUuid(input.conversationId, "conversationId");
  const tokenHash = typeof input.tokenHash === "string" ? input.tokenHash.trim().toLowerCase() : "";
  if (!HASH.test(tokenHash)) throw new Error("tokenHash must be a SHA-256 hex digest.");
  const issuedAt = normalizeUtcTimestamp(input.issuedAt, "issuedAt");
  const expiresAt = normalizeUtcTimestamp(input.expiresAt, "expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime < MIN_ATTRIBUTION_WINDOW_MS || lifetime > DEFAULT_ATTRIBUTION_WINDOW_MS) {
    throw new Error("The attribution intent must expire between five minutes and 30 days after issue.");
  }
  const consumedAt = input.consumedAt == null ? null : normalizeUtcTimestamp(input.consumedAt, "consumedAt");
  return Object.freeze({ schemaVersion: 1, organizationId, conversationId, tokenHash, issuedAt, expiresAt, consumedAt });
}

function matchConfirmedReservationToBookingIntent({ organizationId, reservationEvent, attributionIntent } = {}) {
  const safeOrganizationId = requiredUuid(organizationId, "organizationId");
  const intent = normalizeBookingAttributionIntent(attributionIntent);
  if (intent.organizationId !== safeOrganizationId || intent.consumedAt) return null;
  if (!reservationEvent || typeof reservationEvent !== "object" || Array.isArray(reservationEvent)) return null;
  if (!["reservation.created", "reservation.updated"].includes(reservationEvent.eventType) || reservationEvent.status !== "confirmed") return null;
  if (typeof reservationEvent.attributionToken !== "string" || !TOKEN.test(reservationEvent.attributionToken)) return null;

  const occurredAt = normalizeUtcTimestamp(reservationEvent.occurredAt, "reservationEvent.occurredAt");
  const occurredMs = Date.parse(occurredAt);
  if (occurredMs < Date.parse(intent.issuedAt) || occurredMs > Date.parse(intent.expiresAt)) return null;

  const suppliedHash = Buffer.from(hashBookingAttributionToken(reservationEvent.attributionToken), "hex");
  const storedHash = Buffer.from(intent.tokenHash, "hex");
  if (!timingSafeEqual(suppliedHash, storedHash)) return null;

  const provider = requiredString(reservationEvent.provider, "reservationEvent.provider", 80);
  const providerEventId = requiredString(reservationEvent.eventId, "reservationEvent.eventId");
  const reservationId = requiredString(reservationEvent.reservationId, "reservationEvent.reservationId");
  let bookingValue = null;
  if (Number.isSafeInteger(reservationEvent.totalAmountMinor) && reservationEvent.totalAmountMinor > 0 &&
      typeof reservationEvent.currency === "string" && /^[A-Z]{3}$/.test(reservationEvent.currency) && SUPPORTED_CURRENCIES.has(reservationEvent.currency)) {
    bookingValue = Object.freeze({
      amountMinor: reservationEvent.totalAmountMinor,
      currency: reservationEvent.currency
    });
  }

  return Object.freeze({
    organizationId: safeOrganizationId,
    provider,
    conversationId: intent.conversationId,
    providerEventId,
    reservationId,
    occurredAt,
    matchMethod: "opaque_provider_correlation",
    bookingValue
  });
}

module.exports = {
  DEFAULT_ATTRIBUTION_WINDOW_MS,
  hashBookingAttributionToken,
  issueBookingAttributionIntent,
  normalizeBookingAttributionIntent,
  matchConfirmedReservationToBookingIntent
};
