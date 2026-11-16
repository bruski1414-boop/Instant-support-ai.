"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { createStaffWebhookStore } = require("../staff-webhook-store");

function fakeDb() {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.startsWith("INSERT INTO organization_staff_webhooks")) {
        const row = {
          organization_id: params[0], webhook_url: params[1], encrypted_secret: params[2],
          status: "configured", configured_at: new Date().toISOString(), verified_at: null, last_error: null
        };
        rows.set(params[0], row);
        return { rowCount: 1, rows: [row] };
      }
      if (sql.startsWith("SELECT webhook_url,status")) {
        const row = rows.get(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.startsWith("SELECT webhook_url,encrypted_secret,status")) {
        const row = rows.get(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.startsWith("UPDATE organization_staff_webhooks SET status='verified'")) {
        const row = rows.get(params[0]);
        if (row) { row.status = "verified"; row.verified_at = new Date().toISOString(); row.last_error = null; }
        return { rowCount: row ? 1 : 0, rows: [] };
      }
      if (sql.startsWith("UPDATE organization_staff_webhooks SET status='error'")) {
        const row = rows.get(params[1]);
        if (row) { row.status = "error"; row.last_error = params[0]; }
        return { rowCount: row ? 1 : 0, rows: [] };
      }
      if (sql.startsWith("DELETE FROM organization_staff_webhooks")) {
        const removed = rows.delete(params[0]);
        return { rowCount: removed ? 1 : 0, rows: [] };
      }
      throw new Error("Unexpected query: " + sql);
    }
  };
}

const key = randomBytes(32).toString("base64");
const allowedHosts = "hooks.example.com";

test("per-hotel webhook credentials are encrypted and never returned by status", async () => {
  const db = fakeDb();
  const store = createStaffWebhookStore({ db, encryptionKey: key, allowedHosts });
  const saved = await store.save({
    organizationId: "hotel-a", userId: "owner-a",
    input: { webhookUrl: "https://hooks.example.com/a", webhookSecret: "a-secret-with-more-than-24-chars" }
  });
  assert.equal(saved.configured, true);
  assert.equal(saved.verified, false);
  assert.equal(saved.hostname, "hooks.example.com");
  assert.equal(db.rows.get("hotel-a").encrypted_secret.includes("a-secret-with-more-than-24-chars"), false);
  assert.equal(JSON.stringify(saved).includes("a-secret-with-more-than-24-chars"), false);
  const resolved = await store.resolve("hotel-a");
  assert.equal(resolved.webhookUrl, "https://hooks.example.com/a");
  assert.equal(resolved.webhookSecret, "a-secret-with-more-than-24-chars");
  assert.equal((await store.resolve("hotel-b")), null);
});

test("each hotel resolves only its own endpoint and signing secret", async () => {
  const db = fakeDb();
  const store = createStaffWebhookStore({ db, encryptionKey: key, allowedHosts });
  await store.save({ organizationId: "hotel-a", userId: "owner-a", input: { webhookUrl: "https://hooks.example.com/a", webhookSecret: "alpha-secret-is-long-enough-123" } });
  await store.save({ organizationId: "hotel-b", userId: "owner-b", input: { webhookUrl: "https://hooks.example.com/b", webhookSecret: "bravo-secret-is-long-enough-456" } });
  assert.deepEqual(await store.resolve("hotel-a"), { webhookUrl: "https://hooks.example.com/a", webhookSecret: "alpha-secret-is-long-enough-123", verified: false });
  assert.deepEqual(await store.resolve("hotel-b"), { webhookUrl: "https://hooks.example.com/b", webhookSecret: "bravo-secret-is-long-enough-456", verified: false });
  assert.equal((await store.resolve("hotel-a")).webhookSecret === (await store.resolve("hotel-b")).webhookSecret, false);
});

test("verification and removal affect only the selected hotel", async () => {
  const db = fakeDb();
  const store = createStaffWebhookStore({ db, encryptionKey: key, allowedHosts });
  await store.save({ organizationId: "hotel-a", userId: "owner-a", input: { webhookUrl: "https://hooks.example.com/a", webhookSecret: "alpha-secret-is-long-enough-123" } });
  await store.save({ organizationId: "hotel-b", userId: "owner-b", input: { webhookUrl: "https://hooks.example.com/b", webhookSecret: "bravo-secret-is-long-enough-456" } });
  await store.markVerified("hotel-a");
  assert.equal((await store.getStatus("hotel-a")).verified, true);
  assert.equal((await store.getStatus("hotel-b")).verified, false);
  await store.remove("hotel-a");
  assert.equal((await store.getStatus("hotel-a")).configured, false);
  assert.equal((await store.resolve("hotel-b")).webhookSecret, "bravo-secret-is-long-enough-456");
});

test("saving changed settings resets the previous verification", async () => {
  const db = fakeDb();
  const store = createStaffWebhookStore({ db, encryptionKey: key, allowedHosts });
  await store.save({ organizationId: "hotel-a", userId: "owner-a", input: { webhookUrl: "https://hooks.example.com/a", webhookSecret: "alpha-secret-is-long-enough-123" } });
  await store.markVerified("hotel-a");
  await store.save({ organizationId: "hotel-a", userId: "owner-a", input: { webhookUrl: "https://hooks.example.com/new", webhookSecret: "new-secret-is-long-enough-1234" } });
  assert.equal((await store.getStatus("hotel-a")).verified, false);
});

test("webhook URL must be HTTPS and on the operator allowlist", async () => {
  const store = createStaffWebhookStore({ db: fakeDb(), encryptionKey: key, allowedHosts });
  const validSecret = "a-secret-with-more-than-24-chars";
  await assert.rejects(() => store.save({ organizationId: "a", userId: "u", input: { webhookUrl: "http://hooks.example.com/a", webhookSecret: validSecret } }), /HTTPS/);
  await assert.rejects(() => store.save({ organizationId: "a", userId: "u", input: { webhookUrl: "https://evil.example.net/a", webhookSecret: validSecret } }), /allowlist/);
  await assert.rejects(() => store.save({ organizationId: "a", userId: "u", input: { webhookUrl: "https://user:pass@hooks.example.com/a", webhookSecret: validSecret } }), /HTTPS/);
});

test("webhook encryption and allowlist must both be configured", async () => {
  const db = fakeDb();
  const noKey = createStaffWebhookStore({ db, encryptionKey: "", allowedHosts });
  assert.equal(noKey.encryptionConfigured, false);
  await assert.rejects(() => noKey.save({ organizationId: "a", userId: "u", input: { webhookUrl: "https://hooks.example.com/a", webhookSecret: "a-secret-with-more-than-24-chars" } }), /encryption/i);
  const noAllowlist = createStaffWebhookStore({ db, encryptionKey: key, allowedHosts: "" });
  assert.equal(noAllowlist.allowedHostsConfigured, false);
  await assert.rejects(() => noAllowlist.save({ organizationId: "a", userId: "u", input: { webhookUrl: "https://hooks.example.com/a", webhookSecret: "a-secret-with-more-than-24-chars" } }), /allowlist/);
});
