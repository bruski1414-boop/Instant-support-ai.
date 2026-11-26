"use strict";

const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/i;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PROVIDER = /^[a-z][a-z0-9_-]{1,39}$/;
const IDENTIFIER = /^[A-Za-z0-9._:/# -]{1,200}$/;
const DEFAULT_ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_ATTRIBUTION_WINDOW_MS = 5 * 60 * 1000;
const SUPPORTED_CURRENCIES = new Set(
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("currency")
    : ["EUR", "USD", "GBP", "THB", "AED", "JPY"]
);
const VERIFIED_EVIDENCE = new WeakSet();
const VERIFICATION_METHODS = new Set(["signed_webhook", "api_readback"]);

function requiredUuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(field + " must be a valid UUID.");
  return value.toLowerCase();
}

function requiredProvider(value) {
  if (typeof value !== "string" || !PROVIDER.test(value.trim())) {
    throw new Error("A trusted provider identifier is required.");
  }
  return value.trim();
}

function requiredIdentifier(value, field) {
  if (typeof value !== "string" || !IDENTIFIER.test(value.trim()) ||
      value.split("").some(ch => ch.charCodeAt(0) < 32)) {
    throw new Error(field + " must be a valid provider identifier.");
  }
  return value.trim();
}

function normalizeUtcTimestamp(value, field) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) {
    throw new Error(field + " must be an ISO-8601 UTC timestamp.");
  }
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
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw new Error("A canonical 256-bit booking attribution token is required.");
  }
  const decoded = Buffer.from(token, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== token) {
    throw new Error("A canonical 256-bit base64url booking attribution token is required.");
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
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_ATTRIBUTION_WINDOW_MS ||
      ttlMs > DEFAULT_ATTRIBUTION_WINDOW_MS) {
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
      consumedAt: null,
      revokedAt: null
    })
  });
}

function normalizeBookingAttributionIntent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A booking attribution intent record is required.");
  }
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
  const revokedAt = input.revokedAt == null ? null : normalizeUtcTimestamp(input.revokedAt, "revokedAt");
  if (consumedAt && revokedAt) throw new Error("An attribution intent cannot be both consumed and revoked.");
  return Object.freeze({ schemaVersion: 1, organizationId, conversationId, tokenHash, issuedAt, expiresAt, consumedAt, revokedAt });
}

function normalizeReservationEvent(input, provider) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A provider reservation event is required.");
  }
  const safeProvider = requiredProvider(provider);
  const eventType = typeof input.eventType === "string" ? input.eventType.trim().toLowerCase() : "";
  const status = typeof input.status === "string" ? input.status.trim().toLowerCase() : "";
  if (!["reservation.created", "reservation.updated"].includes(eventType) || status !== "confirmed") {
    throw new Error("Only a provider-confirmed reservation create/update event can be linked.");
  }
  const eventId = requiredIdentifier(input.eventId, "eventId");
  const reservationId = requiredIdentifier(input.reservationId, "reservationId");
  const occurredAt = normalizeUtcTimestamp(input.occurredAt, "occurredAt");
  const attributionToken = input.attributionToken;
  const tokenHash = hashBookingAttributionToken(attributionToken);
  let bookingValue = null;
  const hasAmount = input.totalAmountMinor !== undefined && input.totalAmountMinor !== null;
  const hasCurrency = input.currency !== undefined && input.currency !== null;
  if (hasAmount || hasCurrency) {
    const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
    if (!Number.isSafeInteger(input.totalAmountMinor) || input.totalAmountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(currency) || !SUPPORTED_CURRENCIES.has(currency)) {
      throw new Error("Provider booking value must contain a positive minor-unit amount and supported currency.");
    }
    bookingValue = Object.freeze({ amountMinor: input.totalAmountMinor, currency });
  }
  return Object.freeze({
    provider: safeProvider,
    eventId,
    eventType,
    occurredAt,
    reservationId,
    status,
    attributionToken,
    tokenHash,
    bookingValue
  });
}

async function createVerifiedReservationEvidence({ provider, event, verify, context } = {}) {
  if (typeof verify !== "function") throw new Error("A configured provider verification function is required.");
  const safeProvider = requiredProvider(provider);
  const proof = await verify(Object.freeze({ provider: safeProvider, event, context }));
  if (!proof || proof.verified !== true || !VERIFICATION_METHODS.has(proof.method)) {
    throw new Error("Provider reservation evidence was not verified.");
  }
  const normalized = normalizeReservationEvent(event, safeProvider);
  const evidence = Object.freeze({ ...normalized, verificationMethod: proof.method });
  VERIFIED_EVIDENCE.add(evidence);
  return evidence;
}

function isVerifiedReservationEvidence(value) {
  return Boolean(value && typeof value === "object" && VERIFIED_EVIDENCE.has(value));
}

function matchConfirmedReservationToBookingIntent({ organizationId, verifiedEvidence, attributionIntent } = {}) {
  const safeOrganizationId = requiredUuid(organizationId, "organizationId");
  if (!isVerifiedReservationEvidence(verifiedEvidence)) {
    throw new Error("A provider-verified reservation evidence object is required.");
  }
  const intent = normalizeBookingAttributionIntent(attributionIntent);
  if (intent.organizationId !== safeOrganizationId || intent.consumedAt || intent.revokedAt) return null;
  const occurredMs = Date.parse(verifiedEvidence.occurredAt);
  if (occurredMs < Date.parse(intent.issuedAt) || occurredMs > Date.parse(intent.expiresAt)) return null;
  const suppliedHash = Buffer.from(verifiedEvidence.tokenHash, "hex");
  const storedHash = Buffer.from(intent.tokenHash, "hex");
  if (suppliedHash.length !== storedHash.length || !timingSafeEqual(suppliedHash, storedHash)) return null;
  return Object.freeze({
    organizationId: safeOrganizationId,
    provider: verifiedEvidence.provider,
    conversationId: intent.conversationId,
    providerEventId: verifiedEvidence.eventId,
    reservationId: verifiedEvidence.reservationId,
    occurredAt: verifiedEvidence.occurredAt,
    matchMethod: "opaque_provider_correlation",
    verificationMethod: verifiedEvidence.verificationMethod,
    bookingValue: verifiedEvidence.bookingValue
  });
}

module.exports = {
  DEFAULT_ATTRIBUTION_WINDOW_MS,
  hashBookingAttributionToken,
  issueBookingAttributionIntent,
  normalizeBookingAttributionIntent,
  createVerifiedReservationEvidence,
  isVerifiedReservationEvidence,
  matchConfirmedReservationToBookingIntent
};
