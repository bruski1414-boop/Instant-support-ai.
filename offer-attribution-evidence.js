"use strict";

const EVIDENCE_TYPES = new Set(["pms_record", "payment_receipt", "invoice", "hotel_report"]);
const SUPPORTED_CURRENCIES = new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : ["EUR", "USD", "GBP", "THB", "AED", "JPY", "KWD"]);
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,179}$/;

class OfferAttributionEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "OfferAttributionEvidenceError";
  }
}

function currencyDigits(currency) {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code) || !SUPPORTED_CURRENCIES.has(code)) {
    throw new OfferAttributionEvidenceError("A supported ISO 4217 currency code is required.");
  }
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  } catch {
    throw new OfferAttributionEvidenceError("A supported ISO 4217 currency code is required.");
  }
}

function toMinorUnits(amount, currency, options = {}) {
  if (typeof amount !== "string" && typeof amount !== "number") {
    throw new OfferAttributionEvidenceError("Enter a valid sale amount.");
  }
  const raw = String(amount).trim();
  if (!/^\d{1,12}(?:\.\d{1,4})?$/.test(raw)) {
    throw new OfferAttributionEvidenceError("Enter a positive amount using digits and an optional decimal point.");
  }
  const digits = currencyDigits(currency);
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > digits) {
    throw new OfferAttributionEvidenceError("The amount has too many decimal places for this currency.");
  }
  const factor = 10n ** BigInt(digits);
  const paddedFraction = (fraction + "0".repeat(digits)).slice(0, digits) || "0";
  const minor = BigInt(whole) * factor + BigInt(paddedFraction);
  if (minor < 0n || (minor === 0n && options.allowZero !== true) || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OfferAttributionEvidenceError("Sale value must be a positive, safely representable amount.");
  }
  return Number(minor);
}

function normalizeSaleTimestamp(value) {
  if (typeof value !== "string") {
    throw new OfferAttributionEvidenceError("A sale date and explicit time zone are required.");
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.exec(value);
  if (!match) {
    throw new OfferAttributionEvidenceError("Use an ISO 8601 sale date/time with Z or an explicit UTC offset.");
  }
  const calendarDay = Date.parse(match[1] + "T00:00:00.000Z");
  if (!Number.isFinite(calendarDay) || new Date(calendarDay).toISOString().slice(0, 10) !== match[1]) {
    throw new OfferAttributionEvidenceError("The sale date must be a real calendar date.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new OfferAttributionEvidenceError("The sale date/time is invalid.");
  }
  if (timestamp > Date.now() + 300000) {
    throw new OfferAttributionEvidenceError("The sale date cannot be in the future.");
  }
  return new Date(timestamp).toISOString();
}

function normalizeOfferAttributionUpdate(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const status = typeof value.status === "string" ? value.status.trim() : "";
  const notes = typeof value.notes === "string" ? value.notes.trim() : "";
  if (!["converted", "not_converted"].includes(status) || notes.length > 500) {
    throw new OfferAttributionEvidenceError("Choose converted or not converted and keep notes under 500 characters.");
  }

  if (status === "not_converted") {
    return Object.freeze({
      status,
      amountMinor: null,
      currency: null,
      evidenceType: null,
      evidenceSourceReference: "",
      saleOccurredAt: null,
      notes
    });
  }

  const amountMinor = value.amount_minor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new OfferAttributionEvidenceError("A completed sale needs a positive actual amount in currency minor units.");
  }
  const currency = typeof value.currency === "string" ? value.currency.trim().toUpperCase() : "";
  currencyDigits(currency);

  const evidenceType = typeof value.evidence_type === "string" ? value.evidence_type.trim() : "";
  if (!EVIDENCE_TYPES.has(evidenceType)) {
    throw new OfferAttributionEvidenceError("Choose a supported hotel evidence source type.");
  }
  const evidenceSourceReference = typeof value.evidence_source_reference === "string"
    ? value.evidence_source_reference.trim()
    : "";
  if (!REFERENCE.test(evidenceSourceReference)) {
    throw new OfferAttributionEvidenceError("An opaque hotel evidence reference of 1–180 safe characters is required.");
  }

  return Object.freeze({
    status,
    amountMinor,
    currency,
    evidenceType,
    evidenceSourceReference,
    saleOccurredAt: normalizeSaleTimestamp(value.sale_occurred_at),
    notes
  });
}

module.exports = {
  EVIDENCE_TYPES,
  OfferAttributionEvidenceError,
  currencyDigits,
  toMinorUnits,
  normalizeSaleTimestamp,
  normalizeOfferAttributionUpdate
};
