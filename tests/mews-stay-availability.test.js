"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMewsStayAvailabilityContext, localMidnightToUtc } = require("../mews-stay-availability");

test("converts property-local midnight to UTC across the winter timezone offset", () => {
  assert.equal(localMidnightToUtc("2026-12-02", "Europe/Helsinki"), "2026-12-01T22:00:00.000Z");
  assert.equal(localMidnightToUtc("2026-06-02", "Europe/Helsinki"), "2026-06-01T21:00:00.000Z");
});

test("reports the minimum inventory across every night, never a single-night maximum", async () => {
  const calls = [];
  const connection = {
    organizationId: "hotel-a",
    propertyReference: "property-a",
    timeZone: "Europe/Helsinki",
    service: { id: "rooms", timeUnitPeriod: "Day" },
    client: {
      async getServiceAvailabilityAbsolute(input) {
        calls.push(input);
        return {
          timeUnitStartsUtc: ["2026-12-01T22:00:00.000Z", "2026-12-02T22:00:00.000Z"],
          categoryAvailabilities: [
            { categoryId: "deluxe", availabilities: [4, 1] },
            { categoryId: "suite", availabilities: [0, 2] }
          ]
        };
      }
    }
  };
  const result = await buildMewsStayAvailabilityContext({
    connection, arrivalDate: "2026-12-02", departureDate: "2026-12-04",
    nowUtc: "2026-11-14T10:00:00.000Z"
  });
  assert.equal(result.verified, true);
  assert.equal(result.nights, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].firstTimeUnitStartUtc, "2026-12-01T22:00:00.000Z");
  assert.equal(calls[0].lastTimeUnitStartUtc, "2026-12-02T22:00:00.000Z");
  assert.deepEqual(result.summaries, [
    { category: "deluxe", minimumAvailable: 1 },
    { category: "suite", minimumAvailable: 0 }
  ]);
  assert.match(result.context, /minimum number of rooms available/);
  assert.match(result.context, /not a booking or hold/);
});

test("fails closed when even one night is missing from the provider response", async () => {
  const connection = {
    propertyReference: "property-a", timeZone: "Europe/Helsinki",
    service: { id: "rooms", timeUnitPeriod: "Day" },
    client: { async getServiceAvailabilityAbsolute() {
      return {
        timeUnitStartsUtc: ["2026-12-01T22:00:00.000Z"],
        categoryAvailabilities: [{ categoryId: "deluxe", availabilities: [3] }]
      };
    } }
  };
  const result = await buildMewsStayAvailabilityContext({
    connection, arrivalDate: "2026-12-02", departureDate: "2026-12-04",
    nowUtc: "2026-11-14T10:00:00.000Z"
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, "incomplete_inventory");
  assert.match(result.context, /Do not infer availability/);
});

test("rejects missing, reversed and excessively long stays", async () => {
  const connection = {
    propertyReference: "property-a", timeZone: "Europe/Helsinki",
    service: { id: "rooms", timeUnitPeriod: "Day" },
    client: { async getServiceAvailabilityAbsolute() { throw new Error("must not call"); } }
  };
  const missing = await buildMewsStayAvailabilityContext({ connection, arrivalDate: null, departureDate: "2026-12-04" });
  const reversed = await buildMewsStayAvailabilityContext({ connection, arrivalDate: "2026-12-04", departureDate: "2026-12-02" });
  const long = await buildMewsStayAvailabilityContext({ connection, arrivalDate: "2026-12-01", departureDate: "2027-02-01" });
  assert.equal(missing.reason, "invalid_dates");
  assert.equal(reversed.reason, "invalid_dates");
  assert.equal(long.reason, "stay_too_long");
  const past = await buildMewsStayAvailabilityContext({ connection, arrivalDate: "2026-11-13", departureDate: "2026-11-15", nowUtc: "2026-11-14T10:00:00.000Z" });
  assert.equal(past.reason, "past_dates");
});
