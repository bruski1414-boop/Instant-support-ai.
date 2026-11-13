const ALLOWED_EVENT_TYPES = new Set(["booking_confirmed", "addon_paid"]);
const CURRENCY = /^[A-Z]{3}$/;
const MAX_REFERENCE_LENGTH = 180;

function normalizeRevenueEvent(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const type = typeof value.type === "string" ? value.type.trim() : "";
  const externalReference = typeof value.externalReference === "string" ? value.externalReference.trim() : "";
  const sourceReference = typeof value.sourceReference === "string" ? value.sourceReference.trim() : "";
  const currency = typeof value.currency === "string" ? value.currency.trim().toUpperCase() : "";
  const amountMinor = value.amountMinor;
  const occurredAt = typeof value.occurredAt === "string" ? value.occurredAt : "";

  if (!ALLOWED_EVENT_TYPES.has(type)) throw new Error("Revenue must be a confirmed booking or a paid add-on.");
  if (!externalReference || externalReference.length > MAX_REFERENCE_LENGTH) throw new Error("A valid external booking or payment reference is required.");
  if (!sourceReference || sourceReference.length > MAX_REFERENCE_LENGTH) throw new Error("A hotel source reference is required.");
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("Revenue must be a positive integer amount in minor currency units.");
  if (!CURRENCY.test(currency)) throw new Error("A three-letter ISO currency code is required.");
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) throw new Error("A valid event date is required.");

  return Object.freeze({
    type,
    externalReference,
    sourceReference,
    amountMinor,
    currency,
    occurredAt: new Date(occurredAt).toISOString(),
    attributionStatus: "hotel_attested"
  });
}

module.exports = { normalizeRevenueEvent };
