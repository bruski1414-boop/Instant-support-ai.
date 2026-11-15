"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOffer, selectRelevantOffers, buildOfferContext } = require("../hotel-offers");

const now = Date.parse("2026-11-15T12:00:00.000Z");
function offer(overrides = {}) {
  return {
    id: "spa-1",
    name: "Relaxation massage",
    description: "A 60-minute massage at the hotel spa.",
    category: "spa",
    amountMinor: 250000,
    currency: "THB",
    status: "active",
    availabilityStatus: "available",
    availabilityVerifiedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    ...overrides,
  };
}

test("normalizes a current, available, fully priced offer", () => {
  const result = normalizeOffer(offer(), now);
  assert.equal(result.name, "Relaxation massage");
  assert.equal(result.amountMinor, 250000);
  assert.equal(result.currency, "THB");
});

test("rejects offers with stale or future availability verification", () => {
  assert.equal(normalizeOffer(offer({ availabilityVerifiedAt: new Date(now - 16 * 60_000).toISOString() }), now), null);
  assert.equal(normalizeOffer(offer({ availabilityVerifiedAt: new Date(now + 60_000).toISOString() }), now), null);
});

test("rejects unavailable, inactive, expired, or malformed offers", () => {
  assert.equal(normalizeOffer(offer({ availabilityStatus: "unknown" }), now), null);
  assert.equal(normalizeOffer(offer({ status: "paused" }), now), null);
  assert.equal(normalizeOffer(offer({ expiresAt: new Date(now).toISOString() }), now), null);
  assert.equal(normalizeOffer(offer({ amountMinor: -1 }), now), null);
  assert.equal(normalizeOffer(offer({ currency: "THB!" }), now), null);
});

test("selects only offers matching the guest's expressed intent", () => {
  const results = selectRelevantOffers({
    message: "Could you tell me about spa treatments?",
    offers: [offer(), offer({ id: "dinner-1", category: "dining", name: "Dinner" })],
    now,
  });
  assert.deepEqual(results.map(item => item.id), ["spa-1"]);
});

test("never promotes offers during sensitive or complaint-related requests", () => {
  const results = selectRelevantOffers({
    message: "I need a refund because I had an allergic reaction",
    offers: [offer()],
    now,
  });
  assert.deepEqual(results, []);
});

test("does not recommend offers when the guest has not expressed a matching intent", () => {
  assert.deepEqual(selectRelevantOffers({ message: "What time is checkout?", offers: [offer()], now }), []);
});

test("caps recommendations at three and includes only verified offer context", () => {
  const offers = ["a", "b", "c", "d"].map((id, i) => offer({ id: "spa-" + id, name: "Spa " + i }));
  const selected = selectRelevantOffers({ message: "I would like a massage", offers, now, limit: 10 });
  assert.equal(selected.length, 3);
  const context = buildOfferContext(selected);
  assert.match(context, /price_major_units/);
  assert.match(context, /2500/);
  assert.match(context, /availability_verified_at/);
});
