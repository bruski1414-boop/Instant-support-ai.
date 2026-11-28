"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  PmsIntegrationError,
  validateDateRange,
  normalizeAvailability,
  normalizeBookingRequest,
  normalizeBooking,
  normalizeWebhookEvent,
  createHmacSha256Verifier,
  recordWebhookEvent,
  createPmsRegistry,
  createSandboxAdapter,
} = require("../pms-integration");

test("date ranges require valid ISO dates and a positive stay", () => {
  assert.deepEqual(validateDateRange({ checkIn: "2027-01-10", checkOut: "2027-01-12" }), {
    checkIn: "2027-01-10", checkOut: "2027-01-12",
  });
  assert.throws(() => validateDateRange({ checkIn: "2027-01-12", checkOut: "2027-01-10" }), PmsIntegrationError);
  assert.throws(() => validateDateRange({ checkIn: "not-a-date", checkOut: "2027-01-10" }), PmsIntegrationError);
  assert.throws(() => validateDateRange({ checkIn: "2027-02-30", checkOut: "2027-03-03" }), PmsIntegrationError);
});

test("availability normalizer accepts only bounded, typed provider fields", () => {
  assert.deepEqual(normalizeAvailability({
    roomTypeId: "deluxe", roomTypeName: "Deluxe Room", currency: "thb", amountMinor: 250000, availableUnits: 3,
  }), { roomTypeId: "deluxe", roomTypeName: "Deluxe Room", currency: "THB", amountMinor: 250000, availableUnits: 3 });
  assert.throws(() => normalizeAvailability({ roomTypeId: "x", roomTypeName: "X", currency: "THB", amountMinor: -1, availableUnits: 2 }), PmsIntegrationError);
  assert.throws(() => normalizeAvailability({ roomTypeId: "x", roomTypeName: "X", currency: "THB", amountMinor: 100, availableUnits: "2" }), PmsIntegrationError);
});

test("booking requests require an idempotency key and bounded guest count", () => {
  assert.deepEqual(normalizeBookingRequest({
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe", guestCount: 2, guest: { name: "Alex Guest", phone: "+66812345678" }, idempotencyKey: "booking_req_12345",
  }), {
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe", guestCount: 2, guest: { name: "Alex Guest", phone: "+66812345678" }, idempotencyKey: "booking_req_12345",
  });
  assert.throws(() => normalizeBookingRequest({
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe", guestCount: 2,
  }), PmsIntegrationError);
  assert.throws(() => normalizeBookingRequest({
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe", guestCount: 21, idempotencyKey: "booking_req_12345",
  }), PmsIntegrationError);
  assert.throws(() => normalizeBookingRequest({
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe", guestCount: 2,
    guest: { name: "Alex Guest", phone: "not-a-phone" }, idempotencyKey: "booking_req_12345",
  }), PmsIntegrationError);
});

test("booking responses expose only a validated provider ID and status", () => {
  assert.deepEqual(normalizeBooking({ bookingId: "provider-123", status: "CONFIRMED", guestEmail: "private@example.test" }), {
    bookingId: "provider-123", status: "confirmed",
  });
  assert.throws(() => normalizeBooking({ bookingId: "provider-123", status: "unknown" }), PmsIntegrationError);
});

test("registry advertises sandbox mode without claiming production readiness", async () => {
  const registry = createPmsRegistry([createSandboxAdapter()]);
  assert.deepEqual(registry.list(), [{
    id: "sandbox",
    name: "Veyra PMS adapter sandbox",
    mode: "sandbox",
    capabilities: { availability: false, booking: false, webhooks: false },
  }]);
  assert.deepEqual(await registry.testConnection("sandbox"), {
    provider: "sandbox", providerName: "Veyra PMS adapter sandbox", mode: "sandbox", ok: true, productionReady: false,
  });
  await assert.rejects(() => registry.getAvailability("sandbox", { checkIn: "2027-01-10", checkOut: "2027-01-11" }), error => error.code === "CAPABILITY_UNAVAILABLE");
  await assert.rejects(() => registry.createBooking("sandbox", {
    checkIn: "2027-01-10", checkOut: "2027-01-11", roomTypeId: "deluxe", guestCount: 2, idempotencyKey: "booking_req_12345",
  }), error => error.code === "CAPABILITY_UNAVAILABLE");
});

test("registry rejects duplicate or incomplete adapters and unknown providers", async () => {
  const adapter = createSandboxAdapter();
  assert.throws(() => createPmsRegistry([adapter, adapter]), error => error.code === "DUPLICATE_ADAPTER");
  assert.throws(() => createPmsRegistry([{ id: "bad", name: "Broken", capabilities: {} }]), error => error.code === "INVALID_ADAPTER");
  const registry = createPmsRegistry();
  await assert.rejects(() => registry.testConnection("unknown"), error => error.code === "PROVIDER_UNAVAILABLE");
});


test("webhook events are normalized, time-bounded and size-limited", () => {
  const now = new Date("2027-01-10T12:00:00.000Z");
  assert.deepEqual(normalizeWebhookEvent({
    eventId: "evt_123", eventType: "reservation.confirmed",
    occurredAt: "2027-01-10T11:59:00.000Z", data: { reservationId: "res_123" },
  }, now), {
    eventId: "evt_123", eventType: "reservation.confirmed",
    occurredAt: "2027-01-10T11:59:00.000Z", data: { reservationId: "res_123" },
  });
  assert.throws(() => normalizeWebhookEvent({
    eventId: "evt_old", eventType: "reservation.confirmed",
    occurredAt: "2026-01-01T00:00:00.000Z", data: {},
  }, now), error => error.code === "INVALID_WEBHOOK_EVENT");
  assert.throws(() => normalizeWebhookEvent({
    eventId: "evt_big", eventType: "reservation.confirmed",
    occurredAt: "2027-01-10T11:59:00.000Z", data: { large: "x".repeat(17000) },
  }, now), error => error.code === "WEBHOOK_EVENT_TOO_LARGE");
});

test("registry verifies provider signatures before accepting webhook events", async () => {
  const adapter = {
    id: "signedtest", name: "Signed test provider", mode: "sandbox",
    capabilities: { webhooks: true },
    async testConnection() { return { ok: true }; },
    async verifyWebhook({ headers, rawBody, secret }) {
      return {
        verified: headers["x-test-signature"] === "valid" && rawBody.toString() === '{"id":1}' && secret === "test-secret-long-enough",
        event: {
          eventId: "evt_signed_1", eventType: "reservation.confirmed",
          occurredAt: "2027-01-10T11:59:00.000Z", data: { reservationId: "res_1" },
        },
      };
    },
  };
  const registry = createPmsRegistry([adapter]);
  const accepted = await registry.verifyWebhook("signedtest", {
    headers: { "x-test-signature": "valid" }, rawBody: Buffer.from('{"id":1}'),
    secret: "test-secret-long-enough", receivedAt: new Date("2027-01-10T12:00:00.000Z"),
  });
  assert.equal(accepted.eventId, "evt_signed_1");
  await assert.rejects(() => registry.verifyWebhook("signedtest", {
    headers: { "x-test-signature": "invalid" }, rawBody: Buffer.from('{"id":1}'),
    secret: "test-secret-long-enough", receivedAt: new Date("2027-01-10T12:00:00.000Z"),
  }), error => error.code === "INVALID_WEBHOOK_SIGNATURE");
});

test("webhook event inbox is idempotent and tenant-scoped", async () => {
  const inserted = new Map();
  const db = {
    async query(sql, params) {
      const key = params.slice(0, 3).join(":");
      if (sql.startsWith("INSERT")) {
        if (inserted.has(key)) return { rowCount: 0, rows: [] };
        inserted.set(key, params[4]);
        return { rowCount: 1, rows: [{ id: "event-row" }] };
      }
      if (sql.startsWith("SELECT")) {
        return inserted.has(key)
          ? { rowCount: 1, rows: [{ payload_sha256: inserted.get(key) }] }
          : { rowCount: 0, rows: [] };
      }
      throw new Error("Unexpected database query in webhook inbox test.");
    },
  };
  const event = {
    eventId: "evt_once", eventType: "reservation.confirmed",
    occurredAt: "2027-01-10T11:59:00.000Z", data: { reservationId: "res_once" },
  };
  const first = await recordWebhookEvent(db, "hotel-a", "provider-a", event, new Date("2027-01-10T12:00:00.000Z"));
  const duplicate = await recordWebhookEvent(db, "hotel-a", "provider-a", event, new Date("2027-01-10T12:00:01.000Z"));
  const otherTenant = await recordWebhookEvent(db, "hotel-b", "provider-a", event, new Date("2027-01-10T12:00:02.000Z"));
  assert.deepEqual(first, { accepted: true, duplicate: false, eventId: "evt_once" });
  assert.deepEqual(duplicate, { accepted: false, duplicate: true, eventId: "evt_once" });
  assert.deepEqual(otherTenant, { accepted: true, duplicate: false, eventId: "evt_once" });
  await assert.rejects(
    () => recordWebhookEvent(db, "hotel-a", "provider-a", {
      ...event, data: { reservationId: "different-reservation" },
    }, new Date("2027-01-10T12:00:03.000Z")),
    error => error.code === "WEBHOOK_EVENT_ID_COLLISION" && error.status === 409,
  );
});


test("HMAC webhook verifier binds the original body to a fresh timestamp", () => {
  const secret = "this-is-a-long-test-secret";
  const now = new Date("2027-01-10T12:00:00.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const rawBody = Buffer.from('{"event":"reservation.confirmed"}');
  const digest = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(timestamp + "."), rawBody]))
    .digest("hex");
  const verify = createHmacSha256Verifier({
    signatureHeader: "x-provider-signature",
    timestampHeader: "x-provider-timestamp",
    signaturePrefix: "sha256=",
  });
  const headers = {
    "x-provider-signature": "sha256=" + digest,
    "x-provider-timestamp": timestamp,
  };
  assert.equal(verify({ headers, rawBody, secret, receivedAt: now }), true);
  assert.equal(verify({ headers, rawBody: Buffer.from('{"event":"different"}'), secret, receivedAt: now }), false);
  assert.equal(verify({ headers, rawBody, secret, receivedAt: new Date(now.getTime() + 10 * 60 * 1000) }), false);
  assert.equal(verify({ headers, rawBody, secret: "short", receivedAt: now }), false);
  assert.throws(() => createHmacSha256Verifier({ maxSkewSeconds: 3600 }), error => error.code === "INVALID_VERIFIER_CONFIG");
});


test("production adapters must validate hotel credentials and receive them only in server-side context", async () => {
  const seen = [];
  const adapter = {
    id: "credentialtest",
    name: "Credential test provider",
    mode: "production",
    capabilities: {},
    async validateCredentials(input) {
      if (!input || typeof input.clientId !== "string" || typeof input.clientSecret !== "string") {
        throw new Error("invalid credentials");
      }
      return {
        credentials: { clientId: input.clientId, clientSecret: input.clientSecret },
        scopes: ["availability:read", "reservation:read", "availability:read"],
      };
    },
    async testConnection(context) {
      seen.push(context.credentials);
      return { ok: context.credentials.clientId === "hotel-client" };
    },
  };
  const registry = createPmsRegistry([adapter]);
  const validated = await registry.validateCredentials("credentialtest", {
    clientId: "hotel-client", clientSecret: "never-return-this",
  });
  assert.deepEqual(validated.scopes, ["availability:read", "reservation:read"]);
  assert.equal(validated.credentials.clientSecret, "never-return-this");
  const result = await registry.testConnection("credentialtest", { credentials: validated.credentials });
  assert.equal(result.productionReady, true);
  assert.deepEqual(seen, [validated.credentials]);
  assert.throws(() => createPmsRegistry([{
    id: "unsafeproduction", name: "Unsafe", capabilities: {},
    async testConnection() { return { ok: true }; },
  }]), error => error.code === "INVALID_ADAPTER");
});

test("sandbox adapters cannot accept arbitrary hotel credentials", async () => {
  const registry = createPmsRegistry([createSandboxAdapter()]);
  await assert.rejects(() => registry.validateCredentials("sandbox", { clientSecret: "secret" }),
    error => error.code === "CREDENTIAL_VALIDATION_UNAVAILABLE");
});


test("production provider operations require validated server-side hotel credentials", async () => {
  const calls = [];
  const adapter = {
    id: "securedprovider",
    name: "Secured provider",
    mode: "production",
    capabilities: { availability: true, booking: true },
    async validateCredentials(input) {
      if (!input || input.accessToken !== "server-only-token") throw new Error("invalid or revoked token");
      return { credentials: { accessToken: input.accessToken }, scopes: ["availability:read", "booking:write"] };
    },
    async testConnection(context) { calls.push(["test", context.credentials]); return { ok: true }; },
    async getAvailability(_dates, context) {
      calls.push(["availability", context.credentials]);
      return [{ roomTypeId: "suite", roomTypeName: "Suite", currency: "EUR", amountMinor: 12000, availableUnits: 1 }];
    },
    async createBooking(_request, context) {
      calls.push(["booking", context.credentials]);
      return { bookingId: "booking-1", status: "confirmed" };
    },
  };
  const registry = createPmsRegistry([adapter]);
  const input = { checkIn: "2027-01-10", checkOut: "2027-01-11" };
  const booking = { ...input, roomTypeId: "suite", guestCount: 2, idempotencyKey: "booking_req_12345" };

  await assert.rejects(() => registry.testConnection("securedprovider"), error =>
    error.code === "PROVIDER_CREDENTIALS_REQUIRED" && error.status === 401);
  await assert.rejects(() => registry.getAvailability("securedprovider", input), error =>
    error.code === "PROVIDER_CREDENTIALS_REQUIRED" && error.status === 401);
  await assert.rejects(() => registry.createBooking("securedprovider", booking), error =>
    error.code === "PROVIDER_CREDENTIALS_REQUIRED" && error.status === 401);
  await assert.rejects(() => registry.getAvailability("securedprovider", input, { credentials: {} }), error =>
    error.code === "PROVIDER_CREDENTIALS_REQUIRED");
  await assert.rejects(() => registry.getAvailability("securedprovider", input, {
    credentials: { accessToken: "forged-or-revoked-token" },
  }), error => error.code === "INVALID_CREDENTIALS" && error.status === 401);

  const validated = await registry.validateCredentials("securedprovider", { accessToken: "server-only-token" });
  const context = { credentials: validated.credentials };
  assert.equal((await registry.testConnection("securedprovider", context)).productionReady, true);
  assert.equal((await registry.getAvailability("securedprovider", input, context)).length, 1);
  assert.equal((await registry.createBooking("securedprovider", booking, context)).bookingId, "booking-1");
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([, credentials]) => credentials.accessToken === "server-only-token"));
});

test("availability requests pass a bounded guest count to the provider adapter", async () => {
  let received;
  const registry = createPmsRegistry([{
    id: "testpms", name: "Test PMS", mode: "production",
    capabilities: { availability: true },
    async validateCredentials(credentials) { return { credentials, scopes: ["availability:read"] }; },
    async testConnection() { return { ok: true }; },
    async getAvailability(request) {
      received = request;
      return [{ roomTypeId: "deluxe", roomTypeName: "Deluxe", currency: "THB", amountMinor: 10000, availableUnits: 1 }];
    },
  }]);
  await registry.getAvailability("testpms", { checkIn: "2027-01-10", checkOut: "2027-01-11", guestCount: 4 }, { credentials: { token: "test" } });
  assert.deepEqual(received, { checkIn: "2027-01-10", checkOut: "2027-01-11", guestCount: 4 });
  await assert.rejects(() => registry.getAvailability("testpms", { checkIn: "2027-01-10", checkOut: "2027-01-11", guestCount: 21 }, { credentials: { token: "test" } }), error => error.code === "INVALID_GUEST_COUNT");
});
