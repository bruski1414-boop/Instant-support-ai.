"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createMewsDemoAdminRouter, validateDemoConfig } = require("../mews-demo-admin-router");

function middleware(_req, _res, next) { next(); }
function role() { return middleware; }

function makeDb() {
  const state = { encrypted: null, status: "pending_authorization", queries: [] };
  return {
    state,
    async query(sql, values = []) {
      state.queries.push(sql);
      if (sql.startsWith("INSERT INTO pms_connections")) {
        state.encrypted = values[2];
        state.status = "pending_authorization";
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("SELECT encrypted_credentials")) {
        return state.encrypted ? { rowCount: 1, rows: [{ encrypted_credentials: state.encrypted }] } : { rowCount: 0, rows: [] };
      }
      if (sql.startsWith("SELECT status,connected_at")) {
        return { rowCount: 1, rows: [{ status: state.status, connected_at: null, last_tested_at: null, has_error: false }] };
      }
      if (sql.startsWith("UPDATE pms_connections")) {
        state.status = values[1] === "mews_demo" ? "connected" : state.status;
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    }
  };
}

async function withServer(router, callback) {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/integrations/mews-demo", router);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = server.address();
    await callback("http://127.0.0.1:" + address.port + "/api/admin/integrations/mews-demo");
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const config = {
  clientToken: "demo-client-token",
  accessToken: "demo-access-token",
  clientName: "Veyra demo test",
  serviceId: "service-1",
  resourceCategoryId: "room-1",
  timeZone: "Asia/Bangkok"
};

test("validates required Mews demo settings and IANA timezone", () => {
  assert.equal(validateDemoConfig(config).timeZone, "Asia/Bangkok");
  assert.throws(() => validateDemoConfig({ ...config, timeZone: "Not/A_Timezone" }), /IANA timezone/);
  assert.throws(() => validateDemoConfig({ ...config, accessToken: "" }), /accessToken/);
});

test("Mews demo admin routes remain hidden unless explicitly enabled", async () => {
  const router = createMewsDemoAdminRouter({
    express, db: makeDb(), auth: middleware, role,
    credentialVault: { encrypt: JSON.stringify, decrypt: JSON.parse },
    enabled: false
  });
  await withServer(router, async base => {
    const response = await fetch(base + "/status");
    assert.equal(response.status, 404);
  });
});

test("stores encrypted demo credentials and exposes only read-only connection and availability results", async () => {
  const db = makeDb();
  const vault = {
    encrypt(value) { return "encrypted:" + JSON.stringify(value); },
    decrypt(value) {
      assert.ok(value.startsWith("encrypted:"));
      return JSON.parse(value.slice("encrypted:".length));
    }
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith("/configuration/get")) {
      return { ok: true, status: 200, async json() { return { Enterprise: { Name: "Demo property" } }; } };
    }
    if (url.endsWith("/services/getAvailability")) {
      return { ok: true, status: 200, async json() {
        return {
          TimeUnitStartsUtc: ["2026-12-01T17:00:00Z"],
          CategoryAvailabilities: [{ CategoryId: "room-1", Availabilities: [3] }]
        };
      } };
    }
    throw new Error("Unexpected provider request");
  };
  const router = createMewsDemoAdminRouter({
    express, db, auth: (req, _res, next) => {
      req.actor = { organization_id: "tenant-a", user_id: "staff-a" };
      next();
    }, role, credentialVault: vault, enabled: true, fetchImpl
  });

  await withServer(router, async base => {
    const connect = await fetch(base + "/connect", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config)
    });
    assert.equal(connect.status, 201);
    const connectBody = await connect.json();
    assert.equal(connectBody.bookingWritesEnabled, false);
    assert.equal(JSON.stringify(connectBody).includes(config.accessToken), false);
    assert.ok(db.state.encrypted.startsWith("encrypted:"));

    const status = await fetch(base + "/status");
    const statusBody = await status.json();
    assert.equal(statusBody.configured, true);
    assert.equal(statusBody.bookingWritesEnabled, false);
    assert.equal(JSON.stringify(statusBody).includes(config.accessToken), false);

    const connectionTest = await fetch(base + "/test", { method: "POST" });
    assert.equal(connectionTest.status, 200);
    assert.equal((await connectionTest.json()).verified, true);

    const availability = await fetch(base + "/availability", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ arrivalDate: "2026-12-02", departureDate: "2026-12-03" })
    });
    assert.equal(availability.status, 200);
    const result = await availability.json();
    assert.equal(result.roomsAvailable, 3);
    assert.equal(result.source, "mews_connector_api");
    assert.equal(result.bookingWritesEnabled, false);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(item => !item.url.includes("production")));
    assert.equal(requests.some(item => item.url.endsWith("/reservations/add")), false);
  });
});
