"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsConnectionStore } = require("../mews-connection-store");

const key = Buffer.alloc(32, 7).toString("base64");
const valid = {
  clientToken: "demo-client-secret",
  accessToken: "demo-access-secret",
  serviceId: "service-123",
  propertyReference: "property-123",
  timeZone: "Europe/Helsinki"
};

test("stores Mews credentials encrypted and returns metadata only", async () => {
  let saved;
  const db = { async query(sql, values) {
    if (sql.startsWith("INSERT INTO mews_connections")) {
      saved = values;
      return { rows: [{ organization_id: values[0], service_id: values[2], property_reference: values[3], timezone: values[4], status: "configured" }] };
    }
    throw new Error("Unexpected query");
  } };
  const store = createMewsConnectionStore({ db, encryptionKey: key });
  const result = await store.save({ organizationId: "hotel-a", userId: "owner-a", input: valid });
  assert.equal(result.status, "configured");
  assert.equal(saved[0], "hotel-a");
  assert.doesNotMatch(saved[1], /demo-client-secret|demo-access-secret/);
  assert.equal(saved[2], "service-123");
});

test("rejects invalid property time zones and incomplete credentials", async () => {
  const db = { async query() { throw new Error("Database should not be called"); } };
  const store = createMewsConnectionStore({ db, encryptionKey: key });
  await assert.rejects(store.save({ organizationId: "hotel-a", userId: "owner-a", input: { ...valid, timeZone: "Mars/Olympus" } }), /valid IANA property time zone/);
  await assert.rejects(store.save({ organizationId: "hotel-a", userId: "owner-a", input: { ...valid, accessToken: "" } }), /credentials are missing/);
});

test("refuses to save credentials if server-side encryption is unavailable", async () => {
  const db = { async query() { throw new Error("Database should not be called"); } };
  const store = createMewsConnectionStore({ db, encryptionKey: "" });
  assert.equal(store.encryptionConfigured, false);
  await assert.rejects(store.save({ organizationId: "hotel-a", userId: "owner-a", input: valid }), /encryption is not configured/);
});

test("scopes status and connection resolution to the requested organization", async () => {
  const calls = [];
  const db = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.startsWith("SELECT service_id")) return { rows: [{ service_id: "service-123", property_reference: "property-123", timezone: "Europe/Helsinki", status: "verified" }] };
    if (sql.startsWith("SELECT organization_id,encrypted_credentials")) return { rowCount: 1, rows: [{
      organization_id: values[0],
      encrypted_credentials: require("../storage-security").createTokenCipher(key).encrypt({ clientToken: "client-secret", accessToken: "access-secret" }),
      service_id: "service-123",
      property_reference: "property-123",
      timezone: "Europe/Helsinki"
    }] };
    throw new Error("Unexpected query");
  } };
  const store = createMewsConnectionStore({ db, encryptionKey: key });
  const status = await store.getStatus("hotel-a");
  assert.equal(status.status, "verified");
  assert.equal(calls[0].values[0], "hotel-a");
  const connection = await store.resolve("hotel-b");
  assert.equal(connection.organizationId, "hotel-b");
  assert.equal(connection.service.id, "service-123");
  assert.equal(calls[1].values[0], "hotel-b");
  assert.deepEqual(calls[1].values[1], ["verified"]);
  assert.equal(calls[1].values[2], true);
  assert.equal(Object.hasOwn(connection, "clientToken"), false);
});


async function verifyWithMewsService(service) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const request = JSON.parse(options.body);
    if (path.endsWith("/configuration/get") && request.EnterpriseId !== "property-123") {
      throw new Error("Configuration request was not scoped to the selected hotel.");
    }
    if (path.endsWith("/services/getAll") &&
        (!Array.isArray(request.EnterpriseIds) || request.EnterpriseIds[0] !== "property-123")) {
      throw new Error("Service lookup was not scoped to the selected hotel.");
    }
    const payload = path.endsWith("/configuration/get")
      ? { Enterprise: { Id: "property-123", Name: "Demo Hotel", TimeZoneIdentifier: "Europe/Helsinki" } }
      : path.endsWith("/services/getAll")
        ? { Services: [service], Cursor: null }
        : {};
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const encrypted = require("../storage-security").createTokenCipher(key).encrypt({
    clientToken: "client-secret",
    accessToken: "access-secret"
  });
  const db = {
    async query(sql, values) {
      if (sql.startsWith("SELECT organization_id,encrypted_credentials")) {
        return {
          rowCount: 1,
          rows: [{
            organization_id: values[0],
            encrypted_credentials: encrypted,
            service_id: "service-123",
            property_reference: "property-123",
            timezone: "Europe/Helsinki"
          }]
        };
      }
      if (sql.startsWith("UPDATE mews_connections")) return { rowCount: 1, rows: [] };
      throw new Error("Unexpected query: " + sql);
    }
  };
  try {
    const store = createMewsConnectionStore({ db, encryptionKey: key });
    return await store.verify("hotel-a");
  } finally {
    global.fetch = originalFetch;
  }
}

function mewsService(overrides = {}) {
  return {
    Id: "service-123",
    EnterpriseId: "property-123",
    IsActive: true,
    Data: { Discriminator: "Bookable", Value: { TimeUnitPeriod: "Day" } },
    ...overrides
  };
}

test("Mews verification rejects a daily bookable service belonging to a different enterprise", async () => {
  await assert.rejects(
    verifyWithMewsService(mewsService({ EnterpriseId: "another-property" })),
    /belonging to the configured Mews property/
  );
});

test("Mews verification rejects a daily service that is not Bookable", async () => {
  await assert.rejects(
    verifyWithMewsService(mewsService({ Data: { Discriminator: "Additional", Value: {} } })),
    /belonging to the configured Mews property/
  );
});

test("Mews verification accepts an active daily Bookable service for the configured enterprise", async () => {
  const result = await verifyWithMewsService(mewsService());
  assert.equal(result.verified, true);
  assert.equal(result.serviceTimeUnit, "Day");
  assert.equal(result.propertyTimeZone, "Europe/Helsinki");
});
