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
