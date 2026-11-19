"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createOperaOhipReadOnlyClient } = require("../opera-ohip-readonly-client");

function makeClient(overrides = {}) {
  const calls = [];
  const client = createOperaOhipReadOnlyClient({
    gatewayUrl: "https://example.oraclecloud.com/gateway",
    appKey: "synthetic-app-key",
    hotelId: "SYNTHETIC-HOTEL",
    getAccessToken: async () => "synthetic-access-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    },
    ...overrides
  });
  return { client, calls };
}

test("OHIP client is explicitly read-only and sends server-side auth headers", async () => {
  const { client, calls } = makeClient();
  assert.equal(client.providerId, "oracle_opera");
  assert.equal(client.readOnly, true);
  assert.deepEqual(await client.get({ path: "/property/v1/hotels" }), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer synthetic-access-token");
  assert.equal(calls[0].options.headers["x-app-key"], "synthetic-app-key");
  assert.equal(calls[0].options.headers["x-hotelid"], "SYNTHETIC-HOTEL");
});

test("supports safe query parameters without changing the gateway origin", async () => {
  const { client, calls } = makeClient();
  await client.get({ path: "/sample/v1/availability", query: { hotelId: "SYNTHETIC", count: 5 } });
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://example.oraclecloud.com");
  assert.equal(url.searchParams.get("count"), "5");
});

test("rejects non-HTTPS gateways and unsafe or external paths", async () => {
  assert.throws(() => makeClient({ gatewayUrl: "http://example.com" }), /HTTPS/);
  const { client } = makeClient();
  await assert.rejects(client.get({ path: "//evil.example/path" }), /absolute API path/);
  await assert.rejects(client.get({ path: "/../outside" }), /within the configured/);
});

test("rejects malformed query values and missing token provider", async () => {
  const { client } = makeClient();
  await assert.rejects(client.get({ path: "/safe", query: { bad: { nested: true } } }), /invalid parameter/);
  assert.throws(() => createOperaOhipReadOnlyClient({
    gatewayUrl: "https://example.com", appKey: "key", hotelId: "hotel"
  }), /token provider/);
});

test("does not expose provider error bodies or credentials in HTTP errors", async () => {
  const { client } = makeClient({
    fetchImpl: async () => ({
      ok: false, status: 403, text: async () => "secret provider response"
    })
  });
  await assert.rejects(client.get({ path: "/safe" }), error => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /secret|synthetic-access-token/);
    return true;
  });
});

test("rejects non-JSON and oversized successful responses", async () => {
  const invalid = makeClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html/>" }) });
  await assert.rejects(invalid.client.get({ path: "/safe" }), /non-JSON/);
  const large = makeClient({
    maxResponseBytes: 1024,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "x".repeat(1100) })
  });
  await assert.rejects(large.client.get({ path: "/safe" }), /size limit/);
});


test("calls the documented OPERA Cloud v1 availability route with validated stay filters", async () => {
  const { client, calls } = makeClient();
  await client.getHotelAvailability({
    roomStayStartDate: "2027-02-10",
    roomStayEndDate: "2027-02-13",
    adults: 2,
    children: 1,
    roomStayQuantity: 1,
    limit: 5,
    ratePlanCode: "SYNTHETIC-RATE",
    roomType: "SYNTHETIC-VILLA"
  });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/gateway/par/v1/hotels/SYNTHETIC-HOTEL/availability");
  assert.equal(url.searchParams.get("roomStayStartDate"), "2027-02-10");
  assert.equal(url.searchParams.get("roomStayEndDate"), "2027-02-13");
  assert.equal(url.searchParams.get("adults"), "2");
  assert.equal(url.searchParams.get("children"), "1");
  assert.equal(url.searchParams.get("roomStayQuantity"), "1");
  assert.equal(url.searchParams.get("ratePlanCode"), "SYNTHETIC-RATE");
  assert.equal(url.searchParams.get("roomType"), "SYNTHETIC-VILLA");
});

test("fails closed on invalid OPERA availability dates and occupancy", async () => {
  const { client } = makeClient();
  await assert.rejects(client.getHotelAvailability({
    roomStayStartDate: "2027-02-30", roomStayEndDate: "2027-03-02", adults: 2
  }), /real calendar date/);
  await assert.rejects(client.getHotelAvailability({
    roomStayStartDate: "2027-02-10", roomStayEndDate: "2027-02-12", adults: 0
  }), /adults/);
  await assert.rejects(client.getHotelAvailability({
    roomStayStartDate: "2027-02-10", roomStayEndDate: "2027-02-10", adults: 2
  }), /after roomStayStartDate/);
});
