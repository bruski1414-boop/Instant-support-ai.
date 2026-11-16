"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMewsGuestAvailabilityContext } = require("../mews-guest-availability");

const nowUtc = "2026-11-14T10:00:00.000Z";
const range = {
  firstTimeUnitStartUtc: "2026-12-01T23:00:00.000Z",
  lastTimeUnitStartUtc: "2026-12-01T23:00:00.000Z",
  nowUtc
};
const connection = (organizationId, count = 2) => ({
  organizationId,
  client: {
    async getServiceAvailabilityAbsolute() {
      return {
        timeUnitStartsUtc: ["2026-12-01T23:00:00.000Z"],
        categoryAvailabilities: [{ categoryId: "deluxe", availabilities: [count] }]
      };
    }
  },
  service: { id: "rooms", timeUnitPeriod: "Day" },
  propertyReference: "hotel-property",
  timeZone: "Europe/Helsinki"
});

test("loads availability only from the connection resolved for the current organization", async () => {
  const result = await buildMewsGuestAvailabilityContext({
    organizationId: "hotel-a",
    resolveConnection: async (id) => connection(id, 2),
    ...range
  });
  assert.equal(result.connected, true);
  assert.equal(result.hasAvailableRooms, true);
  assert.equal(result.availabilityCount, 1);
  assert.match(result.context, /2 room\(s\) reported available/);
  assert.equal(result.snapshots[0].arrivalDate, "2026-12-02");
});

test("fails closed when no tenant connection exists", async () => {
  const result = await buildMewsGuestAvailabilityContext({
    organizationId: "hotel-a",
    resolveConnection: async () => null,
    ...range
  });
  assert.equal(result.connected, false);
  assert.equal(result.reason, "not_configured");
  assert.match(result.context, /Do not state or imply that rooms are available/);
});

test("rejects a connection belonging to another tenant without querying it", async () => {
  let queried = false;
  const result = await buildMewsGuestAvailabilityContext({
    organizationId: "hotel-a",
    resolveConnection: async () => {
      const value = connection("hotel-b");
      value.client.getServiceAvailabilityAbsolute = async () => {
        queried = true;
        throw new Error("must not be called");
      };
      return value;
    },
    ...range
  });
  assert.equal(result.connected, false);
  assert.equal(result.reason, "tenant_mismatch");
  assert.equal(queried, false);
});

test("fails closed on provider errors and malformed connection data", async () => {
  const providerFailure = await buildMewsGuestAvailabilityContext({
    organizationId: "hotel-a",
    resolveConnection: async () => {
      const value = connection("hotel-a");
      value.client.getServiceAvailabilityAbsolute = async () => { throw new Error("private provider details"); };
      return value;
    },
    ...range
  });
  assert.equal(providerFailure.reason, "provider_unavailable");
  assert.doesNotMatch(providerFailure.context, /private provider details/);

  const malformed = await buildMewsGuestAvailabilityContext({
    organizationId: "hotel-a",
    resolveConnection: async (id) => ({ organizationId: id, client: {} }),
    ...range
  });
  assert.equal(malformed.reason, "incomplete_connection");
});

test("does not claim availability when the provider reports zero rooms", async () => {
  const result = await buildMewsGuestAvailabilityContext({
    organizationId: "hotel-a",
    resolveConnection: async (id) => connection(id, 0),
    ...range
  });
  assert.equal(result.connected, true);
  assert.equal(result.hasAvailableRooms, false);
  assert.match(result.context, /0 room\(s\) reported available/);
});
