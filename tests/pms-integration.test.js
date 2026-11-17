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
  createMewsConnectorAdapter,
  localDateTimeToUtc,
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

test("booking requests validate and normalize guest details and verified deposits", () => {
  const input = {
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe",
    guestCount: 2, idempotencyKey: "booking_req_12345",
    guest: { name: "  Ada   Lovelace ", phone: "+1 (202) 555-0123", email: "ADA@example.com" },
    totalAmountMinor: 10001, depositAmountMinor: 5001, currency: "USD",
    depositVerified: true, paidAmountMinor: 5001, paidCurrency: "USD",
  };
  assert.deepEqual(normalizeBookingRequest(input), {
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "deluxe",
    guestCount: 2, idempotencyKey: "booking_req_12345",
    guest: { name: "Ada Lovelace", phone: "+12025550123", email: "ada@example.com" },
    totalAmountMinor: 10001, depositAmountMinor: 5001, currency: "USD", depositVerified: true,
  });
  assert.throws(() => normalizeBookingRequest({ ...input, guest: { ...input.guest, phone: "not-a-phone" } }),
    error => error.code === "INVALID_GUEST_DETAILS");
  assert.throws(() => normalizeBookingRequest({ ...input, paidAmountMinor: 1000 }),
    error => error.code === "VERIFIED_DEPOSIT_REQUIRED");
  assert.throws(() => normalizeBookingRequest({ ...input, idempotencyKey: "" }),
    error => error.code === "INVALID_BOOKING_REQUEST");
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
    capabilities: { availability: true, booking: false, webhooks: false },
  }]);
  assert.deepEqual(await registry.testConnection("sandbox"), {
    provider: "sandbox", providerName: "Veyra PMS adapter sandbox", mode: "sandbox", ok: true, productionReady: false,
  });
  assert.deepEqual(await registry.getAvailability("sandbox", { checkIn: "2027-01-10", checkOut: "2027-01-11" }), []);
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


test("Mews local hotel times convert to UTC using the configured IANA zone", () => {
  assert.equal(localDateTimeToUtc("2027-01-10", "14:00:00", "Asia/Bangkok"), "2027-01-10T07:00:00.000Z");
  assert.equal(localDateTimeToUtc("2027-07-10", "14:00:00", "Europe/London"), "2027-07-10T13:00:00.000Z");
  assert.throws(() => localDateTimeToUtc("2027-03-14", "02:30:00", "America/New_York"),
    error => error.code === "INVALID_LOCAL_DATETIME");
  assert.throws(() => localDateTimeToUtc("2027-01-10", "14:00:00", "Not/A_Zone"),
    error => error.code === "INVALID_TIME_ZONE");
});

test("Mews connector creates a confirmed reservation with guest details and local-time conversion", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ url, payload });
    if (url.endsWith("/customers/add")) return { ok: true, async json() { return { Id: "customer-1" }; } };
    if (url.endsWith("/reservations/add")) return {
      ok: true, async json() { return { Reservations: [{ Id: "reservation-1", Number: "42", State: "Confirmed" }] }; },
    };
    return { ok: true, async json() { return {}; } };
  };
  const adapter = createMewsConnectorAdapter({ fetchImpl });
  const registry = createPmsRegistry([adapter]);
  const request = {
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "category-deluxe",
    guestCount: 2, idempotencyKey: "booking_req_12345",
    guest: { name: "Ada Lovelace", phone: "+12025550123", email: "ada@example.com" },
    totalAmountMinor: 10000, depositAmountMinor: 5000, currency: "USD",
    depositVerified: true, paidAmountMinor: 5000, paidCurrency: "USD",
  };
  const result = await registry.createBooking("mews", request, {
    credentials: { clientToken: "client-token", accessToken: "access-token" },
    propertyConfig: {
      serviceId: "service-1", rateId: "rate-1", requestedCategoryId: "category-deluxe",
      adultAgeCategoryId: "adult-1", timeZone: "Asia/Bangkok",
    },
  });
  assert.deepEqual(result, { bookingId: "reservation-1", status: "confirmed" });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.endsWith("/reservations/getAll/2023-06-06"), true);
  assert.equal(calls[1].payload.Phone, "+12025550123");
  assert.equal(calls[1].payload.Email, "ada@example.com");
  assert.equal(calls[2].payload.Reservations[0].StartUtc, "2027-01-10T07:00:00.000Z");
  assert.equal(calls[2].payload.Reservations[0].EndUtc, "2027-01-12T03:00:00.000Z");
  assert.equal(calls[2].payload.Reservations[0].ChannelNumber, "booking_req_12345");
  assert.equal(calls[2].payload.CheckOverbooking, true);
  assert.equal(calls[2].payload.CheckRateApplicability, true);
});


test("Mews retries reuse the existing reservation instead of creating another one", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ url, payload });
    if (url.endsWith("/reservations/getAll/2023-06-06")) return {
      ok: true, async json() { return { Reservations: [{
        Id: "existing-reservation", Number: "77", State: "Confirmed", ChannelNumber: "booking_req_12345",
      }] }; },
    };
    throw new Error("A retry must not create a new customer or reservation.");
  };
  const registry = createPmsRegistry([createMewsConnectorAdapter({ fetchImpl })]);
  const request = {
    checkIn: "2027-01-10", checkOut: "2027-01-12", roomTypeId: "category-deluxe",
    guestCount: 1, idempotencyKey: "booking_req_12345",
    guest: { name: "Ada Lovelace", phone: "+12025550123" },
    totalAmountMinor: 10000, depositAmountMinor: 5000, currency: "USD",
    depositVerified: true, paidAmountMinor: 5000, paidCurrency: "USD",
  };
  const result = await registry.createBooking("mews", request, {
    credentials: { clientToken: "client-token", accessToken: "access-token" },
    propertyConfig: {
      serviceId: "service-1", rateId: "rate-1", requestedCategoryId: "category-deluxe",
      adultAgeCategoryId: "adult-1", timeZone: "Asia/Bangkok",
    },
  });
  assert.deepEqual(result, { bookingId: "existing-reservation", status: "confirmed" });
  assert.equal(calls.length, 1);
});


test("Mews reservation creation uses the documented Add reservations request fields", async () => {
  const calls = [];
  const adapter = createMewsConnectorAdapter({
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      calls.push({ url, payload });
      let body = {};
      if (url.endsWith("/services/getAll")) body = { Services: [] };
      else if (url.endsWith("/reservations/getAll/2023-06-06")) body = { Reservations: [] };
      else if (url.endsWith("/customers/add")) body = { Id: "customer-1" };
      else if (url.endsWith("/reservations/add")) {
        body = { Reservations: [{ Reservation: { Id: "reservation-1", State: "Confirmed", Number: "42" } }] };
      } else throw new Error("Unexpected Mews endpoint: " + url);
      return { ok: true, status: 200, async json() { return body; } };
    },
  });
  const result = await adapter.createBooking({
    checkIn: "2027-01-10",
    checkOut: "2027-01-12",
    roomTypeId: "category-1",
    guestCount: 2,
    idempotencyKey: "booking_req_12345",
    guest: { name: "Ada Lovelace", phone: "+12025550123", email: "ada@example.com" },
  }, {
    credentials: { clientToken: "client-token", accessToken: "access-token" },
    propertyConfig: {
      serviceId: "service-1",
      rateId: "rate-1",
      requestedCategoryId: "category-1",
      adultAgeCategoryId: "adult-1",
      timeZone: "UTC",
      checkInTime: "14:00:00",
      checkOutTime: "10:00:00",
    },
  });
  const addCall = calls.find(call => call.url.endsWith("/reservations/add"));
  assert.ok(addCall);
  assert.equal(addCall.payload.Reservations[0].StartUtc, "2027-01-10T14:00:00.000Z");
  assert.equal(addCall.payload.Reservations[0].EndUtc, "2027-01-12T10:00:00.000Z");
  assert.equal("ScheduledStartUtc" in addCall.payload.Reservations[0], false);
  assert.equal("ScheduledEndUtc" in addCall.payload.Reservations[0], false);
  assert.deepEqual(result, {
    bookingId: "reservation-1",
    status: "confirmed",
    customerId: "customer-1",
    confirmationNumber: "42",
  });
});
