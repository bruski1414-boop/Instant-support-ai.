"use strict";

const { currencyDigits } = require("./offer-attribution-evidence");

const MAX_AVAILABILITY_AGE_MS = 15 * 60 * 1000;
const MAX_RECOMMENDATIONS = 3;

const INTENT_KEYWORDS = {
  dining: /\b(food|eat|dinner|lunch|breakfast|restaurant|meal|drink|bar)\b/i,
  spa: /\b(spa|massage|wellness|facial|treatment|relax)\b/i,
  transport: /\b(airport|transfer|taxi|transport|pickup|drop.?off|car)\b/i,
  room_upgrade: /\b(upgrade|larger room|suite|better room|sea view|ocean view)\b/i,
  experience: /\b(activity|excursion|tour|experience|boat|diving|snorkel|trip)\b/i,
};

const SENSITIVE_REQUEST = /\b(emergency|fire|smoke|gas leak|allergy|allergic|injury|hurt|complaint|refund|chargeback|payment dispute|cancel|cancellation|booking change|change my reservation|medical|unsafe|harass|stolen)\b/i;

function validDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOffer(offer, now = Date.now()) {
  if (!offer || typeof offer !== "object" || Array.isArray(offer)) return null;
  const id = typeof offer.id === "string" ? offer.id.trim() : "";
  const name = typeof offer.name === "string" ? offer.name.trim() : "";
  const description = typeof offer.description === "string" ? offer.description.trim() : "";
  const category = typeof offer.category === "string" ? offer.category.trim() : "";
  const currency = typeof offer.currency === "string" ? offer.currency.trim().toUpperCase() : "";
  const amountMinor = offer.amountMinor;
  const verifiedAt = validDate(offer.availabilityVerifiedAt);
  const expiresAt = validDate(offer.expiresAt);

  if (!id || id.length > 80 || !name || name.length > 120) return null;
  if (!description || description.length > 400) return null;
  if (!Object.hasOwn(INTENT_KEYWORDS, category)) return null;
  let minorUnitDigits;
  try { minorUnitDigits = currencyDigits(currency); } catch { return null; }
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return null;
  if (offer.status !== "active" || offer.availabilityStatus !== "available") return null;
  if (verifiedAt === null || verifiedAt > now || now - verifiedAt > MAX_AVAILABILITY_AGE_MS) return null;
  if (expiresAt === null || expiresAt <= now) return null;

  return {
    id,
    name,
    description,
    category,
    amountMinor,
    currency,
    minorUnitDigits,
    availabilityVerifiedAt: new Date(verifiedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function selectRelevantOffers({ message, offers, now = Date.now(), limit = MAX_RECOMMENDATIONS } = {}) {
  if (typeof message !== "string" || !message.trim() || !Array.isArray(offers)) return [];
  if (SENSITIVE_REQUEST.test(message)) return [];

  const requestedCategories = Object.entries(INTENT_KEYWORDS)
    .filter(([, pattern]) => pattern.test(message))
    .map(([category]) => category);
  if (!requestedCategories.length) return [];

  const safeLimit = Number.isInteger(limit) ? Math.max(0, Math.min(limit, MAX_RECOMMENDATIONS)) : MAX_RECOMMENDATIONS;
  if (!safeLimit) return [];

  const relevant = [];
  for (const offer of offers) {
    const normalized = normalizeOffer(offer, now);
    if (normalized && requestedCategories.includes(normalized.category)) relevant.push(normalized);
    if (relevant.length >= safeLimit) break;
  }
  return relevant;
}

function buildOfferContext(offers) {
  if (!Array.isArray(offers) || !offers.length) return "No current, verified hotel offers are available for this request. Do not invent promotions, prices, or availability.";
  return offers.map(offer =>
    JSON.stringify({
      name: offer.name,
      description: offer.description,
      category: offer.category,
      price_major_units: Number((offer.amountMinor / (10 ** currencyDigits(offer.currency))).toFixed(currencyDigits(offer.currency))),
      currency: offer.currency,
      availability_verified_at: offer.availabilityVerifiedAt,
      offer_expires_at: offer.expiresAt,
    })
  ).join("\n");
}

module.exports = {
  MAX_AVAILABILITY_AGE_MS,
  normalizeOffer,
  selectRelevantOffers,
  buildOfferContext,
};
