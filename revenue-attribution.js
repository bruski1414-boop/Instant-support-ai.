const ALLOWED_EVENT_TYPES = new Set(["booking_confirmed", "addon_paid"]);
const CURRENCY = /^[A-Z]{3}$/;
const REFERENCE = /^[A-Za-z0-9._:/# -]{1,180}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toMinorUnits(amount, currency) {
  if (typeof amount !== "string" && typeof amount !== "number") throw new Error("Enter a valid revenue amount.");
  const raw = String(amount).trim();
  if (!/^\d{1,12}(\.\d{1,4})?$/.test(raw)) throw new Error("Enter a positive amount using digits and an optional decimal point.");
  let digits;
  try { digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits; }
  catch { throw new Error("A valid ISO currency code is required."); }
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > digits) throw new Error("The amount has too many decimal places for this currency.");
  const minor = Number(whole) * (10 ** digits) + Number((fraction + "0".repeat(digits)).slice(0, digits) || 0);
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error("Revenue must be a positive amount.");
  return minor;
}

function normalizeRevenueEvent(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const type = typeof value.type === "string" ? value.type.trim() : "";
  const externalReference = typeof value.externalReference === "string" ? value.externalReference.trim() : "";
  const sourceReference = typeof value.sourceReference === "string" ? value.sourceReference.trim() : "";
  const currency = typeof value.currency === "string" ? value.currency.trim().toUpperCase() : "";
  const occurredAt = typeof value.occurredAt === "string" ? value.occurredAt : "";
  const conversationId = value.conversationId == null || value.conversationId === "" ? null : String(value.conversationId).trim();

  if (!ALLOWED_EVENT_TYPES.has(type)) throw new Error("Revenue must be a confirmed booking or a paid add-on.");
  if (!REFERENCE.test(externalReference)) throw new Error("A valid external booking or payment reference is required.");
  if (!sourceReference || sourceReference.length > 180 || /[\\u0000-\\u001f]/.test(sourceReference)) throw new Error("A hotel source reference is required.");
  if (!CURRENCY.test(currency)) throw new Error("A three-letter ISO currency code is required.");
  const amountMinor = Number.isSafeInteger(value.amountMinor) ? value.amountMinor : toMinorUnits(value.amount, currency);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("Revenue must be a positive integer amount in minor currency units.");
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) throw new Error("A valid event date is required.");
  if (conversationId && !UUID.test(conversationId)) throw new Error("Choose a valid Veyra conversation reference.");
  if (Date.parse(occurredAt) > Date.now() + 300000) throw new Error("The revenue event date cannot be in the future.");

  return Object.freeze({
    type, externalReference, sourceReference, amountMinor, currency,
    occurredAt: new Date(occurredAt).toISOString(),
    conversationId,
    attributionStatus: conversationId ? "veyra_linked_hotel_attested" : "hotel_reported_unlinked"
  });
}

module.exports = { normalizeRevenueEvent, toMinorUnits };
