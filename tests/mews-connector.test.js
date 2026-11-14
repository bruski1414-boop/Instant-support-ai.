"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsConnectorClient, DEMO_BASE_URL } = require("../mews-connector");

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { fetchImpl, calls };
}
function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}
const credentials = { clientToken: "demo-client-token", accessToken: "demo-property-token" };

test("uses the official Mews demo host and required authentication body", async () => {
  const mock = mockFetch(async () => jsonResponse({ NowUtc: "2026-11-14T10:00:00Z", Enterprise: { Id: "hotel-1", Name: "Demo Hotel", TimeZoneIdentifier: "Europe/Helsinki" } }));
  const client = createMewsConnectorClient({ ...credentials, fetchImpl: mock.fetchImpl });
  const config = await client.getConfiguration();
  assert.equal(mock.calls[0].url, DEMO_BASE_URL + "/api/connector/v1/configuration/get");
  const body = JSON.parse(mock.calls[0].options.body);
  assert.equal(body.ClientToken, credentials.clientToken);
  assert.equal(body.AccessToken, credentials.accessToken);
  assert.equal(config.enterprise.name, "Demo Hotel");
});

test("refuses production or arbitrary API hosts", () => {
  assert.throws(() => createMewsConnectorClient({ ...credentials, baseUrl: "https://api.mews.com" }), /demo environment/);
  assert.throws(() => createMewsConnectorClient({ ...credentials, baseUrl: "https://attacker.invalid" }), /demo environment/);
});

test("maps service list to minimal Veyra service records", async () => {
  const mock = mockFetch(async () => jsonResponse({ Services: [{ Id: "svc-1", EnterpriseId: "hotel-1", IsActive: true, Names: { "en-US": "Accommodation" }, Data: { Discriminator: "Bookable" }, ExternalIdentifier: "ROOMS", Customer: { Email: "private@example.invalid" } }], Cursor: "next" }));
  const client = createMewsConnectorClient({ ...credentials, fetchImpl: mock.fetchImpl });
  const result = await client.getServices({ count: 50 });
  assert.equal(result.services[0].id, "svc-1");
  assert.equal(result.cursor, "next");
  assert.equal("Customer" in result.services[0], false);
  assert.equal(JSON.parse(mock.calls[0].options.body).Limitation.Count, 50);
});

test("maps only current reservation summary fields and uses the versioned getAll operation", async () => {
  const mock = mockFetch(async () => jsonResponse({
    Reservations: [{
      Id: "res-1", ServiceId: "svc-1", State: "Confirmed",
      RequestedResourceCategoryId: "room-deluxe",
      ScheduledStartUtc: "2026-12-01T15:00:00Z",
      ScheduledEndUtc: "2026-12-04T11:00:00Z",
      ActualStartUtc: null, ActualEndUtc: null,
      CreatedUtc: "2026-11-01T12:00:00Z", UpdatedUtc: "2026-11-02T12:00:00Z",
      AccountId: "guest-account", QrCodeData: "private-qr", CreditCardId: "card-reference",
      Customer: { Email: "private@example.invalid" }, Notes: ["private note"]
    }],
    Cursor: "res-1"
  }));
  const client = createMewsConnectorClient({ ...credentials, fetchImpl: mock.fetchImpl });
  const result = await client.getReservations({ states: ["Confirmed"], count: 25 });
  assert.match(mock.calls[0].url, /reservations\/getAll\/2023-06-06$/);
  assert.equal(JSON.parse(mock.calls[0].options.body).States[0], "Confirmed");
  assert.equal(result.reservations[0].id, "res-1");
  assert.equal(result.reservations[0].scheduledStartUtc, "2026-12-01T15:00:00Z");
  assert.equal("Customer" in result.reservations[0], false);
  assert.equal("CreditCardId" in result.reservations[0], false);
  assert.equal("QrCodeData" in result.reservations[0], false);
  assert.equal(result.cursor, "res-1");
});

test("validates reservation filters and three-month incremental window before network access", async () => {
  const mock = mockFetch(async () => jsonResponse({}));
  const client = createMewsConnectorClient({ ...credentials, fetchImpl: mock.fetchImpl });
  await assert.rejects(() => client.getReservations({ states: ["Unknown"] }), /supported Mews reservation states/);
  await assert.rejects(() => client.getReservations({
    updatedUtc: { startUtc: "2026-01-01T00:00:00Z", endUtc: "2026-05-01T00:00:00Z" }
  }), /three-month/);
  assert.equal(mock.calls.length, 0);
});

test("requests availability with the documented versioned endpoint and returns only availability fields", async () => {
  const mock = mockFetch(async () => jsonResponse({ TimeUnitStartsUtc: ["2026-12-01T00:00:00Z"], ResourceCategoryAvailabilities: [{ ResourceCategoryId: "room-deluxe", Metrics: { UsableResources: [8], ConfirmedReservations: [5] }, GuestEmail: "private@example.invalid" }] }));
  const client = createMewsConnectorClient({ ...credentials, fetchImpl: mock.fetchImpl });
  const result = await client.getServiceAvailability({
    serviceId: "svc-1",
    firstTimeUnitStartUtc: "2026-12-01T00:00:00Z",
    lastTimeUnitStartUtc: "2026-12-02T00:00:00Z"
  });
  assert.match(mock.calls[0].url, /getAvailability\/2024-01-22$/);
  assert.equal(result.resourceCategoryAvailabilities[0].resourceCategoryId, "room-deluxe");
  assert.equal("GuestEmail" in result.resourceCategoryAvailabilities[0], false);
});

test("rejects invalid availability ranges and unknown metrics before network access", async () => {
  const mock = mockFetch(async () => jsonResponse({}));
  const client = createMewsConnectorClient({ ...credentials, fetchImpl: mock.fetchImpl });
  await assert.rejects(() => client.getServiceAvailability({
    serviceId: "svc-1",
    firstTimeUnitStartUtc: "2026-12-03T00:00:00Z",
    lastTimeUnitStartUtc: "2026-12-02T00:00:00Z"
  }), /must not be before/);
  await assert.rejects(() => client.getServiceAvailability({
    serviceId: "svc-1",
    firstTimeUnitStartUtc: "2026-12-01T00:00:00Z",
    lastTimeUnitStartUtc: "2026-12-02T00:00:00Z",
    metrics: ["GuestEmails"]
  }), /unsupported/);
  assert.equal(mock.calls.length, 0);
});

test("does not leak raw Mews error bodies", async () => {
  const mock = mockFetch(async () => jsonResponse({ Error: "token secret and guest payload" }, 401));
  const client = createMewsConnectorClient({ ...credentials, fetchImpl: mock.fetchImpl });
  await assert.rejects(() => client.getConfiguration(), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message.includes("guest payload"), false);
    assert.equal(error.message.includes("token secret"), false);
    return true;
  });
});
