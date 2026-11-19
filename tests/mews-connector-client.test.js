"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsConnectorClient } = require("../mews-connector-client");

function makeClient(fetchImpl, overrides = {}) {
  return createMewsConnectorClient({
    environment: "demo",
    clientToken: "demo-client-token",
    accessToken: "demo-property-token",
    clientName: "Veyra AI Test",
    tenantId: "hotel-demo",
    fetchImpl,
    ...overrides
  });
}

test("uses Mews demo host and adds credentials server-side", async () => {
  let call;
  const client = makeClient(async (url, options) => {
    call = { url, options };
    return { ok: true, status: 200, json: async () => ({ Enterprise: { Id: "demo-id" } }) };
  });
  const result = await client.getConfiguration();
  assert.equal(call.url, "https://api.mews-demo.com/api/connector/v1/configuration/get");
  const body = JSON.parse(call.options.body);
  assert.equal(body.ClientToken, "demo-client-token");
  assert.equal(body.AccessToken, "demo-property-token");
  assert.equal(body.Client, "Veyra AI Test");
  assert.equal(result.Enterprise.Id, "demo-id");
  assert.equal(client.readOnly, true);
});

test("supports documented read-only availability request", async () => {
  let body;
  const client = makeClient(async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ CategoryAvailabilities: [] }) };
  });
  await client.getAvailability({
    ServiceId: "service-id",
    FirstTimeUnitStartUtc: "2026-12-02T00:00:00Z",
    LastTimeUnitStartUtc: "2026-12-04T00:00:00Z"
  });
  assert.equal(body.ServiceId, "service-id");
  assert.equal(body.FirstTimeUnitStartUtc, "2026-12-02T00:00:00Z");
});

test("rejects unsupported operations and attempts to override credentials", async () => {
  const client = makeClient(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  await assert.rejects(() => client.getServices({ ClientToken: "attacker-value" }), /managed by the connector/);
  await assert.rejects(() => client.getServices([]), /must be an object/);
  assert.equal(typeof client.createReservation, "undefined");
});

test("rejects invalid environment and missing tenant identity", () => {
  assert.throws(() => makeClient(async () => ({}), { environment: "unknown" }), /environment/);
  assert.throws(() => makeClient(async () => ({}), { tenantId: "" }), /tenantId/);
});

test("surfaces rate limiting without retrying a potentially unsafe request", async () => {
  const client = makeClient(async () => ({
    ok: false,
    status: 429,
    headers: { get: () => "5" }
  }));
  await assert.rejects(
    () => client.getServices(),
    error => error.status === 429 && error.retryAfter === "5"
  );
});
