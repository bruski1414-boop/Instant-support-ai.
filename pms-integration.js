"use strict";

const crypto = require("node:crypto");

const PROVIDER_KEY = /^[a-z][a-z0-9_-]{1,39}$/;
const BOOKING_STATUSES = new Set(["confirmed","pending","cancelled","modified","checked_in","checked_out"]);
const CURRENCIES = /^[A-Z]{3}$/;

class PmsIntegrationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "PmsIntegrationError";
    this.code = code;
    this.status = status;
  }
}

function validateDateRange(input = {}) {
  const checkIn = typeof input.checkIn === "string" ? input.checkIn : "";
  const checkOut = typeof input.checkOut === "string" ? input.checkOut : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    throw new PmsIntegrationError("INVALID_DATE_RANGE", "Check-in and check-out must be ISO dates.");
  }
  const start = Date.parse(checkIn + "T00:00:00Z");
  const end = Date.parse(checkOut + "T00:00:00Z");
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString().slice(0, 10) !== checkIn || new Date(end).toISOString().slice(0, 10) !== checkOut || end <= start) {
    throw new PmsIntegrationError("INVALID_DATE_RANGE", "Check-out must be after check-in.");
  }
  if (end - start > 366 * 86400000) {
    throw new PmsIntegrationError("DATE_RANGE_TOO_LARGE", "Date range cannot exceed 366 nights.");
  }
  return { checkIn, checkOut };
}

function normalizeAvailability(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PmsIntegrationError("INVALID_PROVIDER_RESPONSE", "Provider returned an invalid availability response.", 502);
  }
  const roomTypeId = typeof value.roomTypeId === "string" ? value.roomTypeId.trim() : "";
  const roomTypeName = typeof value.roomTypeName === "string" ? value.roomTypeName.trim() : "";
  const currency = typeof value.currency === "string" ? value.currency.trim().toUpperCase() : "";
  const amountMinor = value.amountMinor;
  const availableUnits = value.availableUnits;
  if (!roomTypeId || roomTypeId.length > 120 || !roomTypeName || roomTypeName.length > 160 ||
      !CURRENCIES.test(currency) || !Number.isSafeInteger(amountMinor) || amountMinor < 0 ||
      !Number.isSafeInteger(availableUnits) || availableUnits < 0) {
    throw new PmsIntegrationError("INVALID_PROVIDER_RESPONSE", "Provider returned incomplete or unsafe availability fields.", 502);
  }
  return { roomTypeId, roomTypeName, currency, amountMinor, availableUnits };
}

function normalizeBookingRequest(input = {}) {
  const dates = validateDateRange(input);
  const roomTypeId = typeof input.roomTypeId === "string" ? input.roomTypeId.trim() : "";
  const guestCount = input.guestCount;
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!roomTypeId || roomTypeId.length > 120 || !Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20 ||
      !/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) {
    throw new PmsIntegrationError("INVALID_BOOKING_REQUEST", "Room type, guest count and idempotency key are required.");
  }
  return { ...dates, roomTypeId, guestCount, idempotencyKey };
}

function normalizeBooking(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PmsIntegrationError("INVALID_PROVIDER_RESPONSE", "Provider returned an invalid booking response.", 502);
  }
  const bookingId = typeof value.bookingId === "string" ? value.bookingId.trim() : "";
  const status = typeof value.status === "string" ? value.status.trim().toLowerCase() : "";
  if (!bookingId || bookingId.length > 160 || !BOOKING_STATUSES.has(status)) {
    throw new PmsIntegrationError("INVALID_PROVIDER_RESPONSE", "Provider returned incomplete booking details.", 502);
  }
  return { bookingId, status };
}

function createHmacSha256Verifier(options = {}) {
  const signatureHeader = String(options.signatureHeader || "x-pms-signature").toLowerCase();
  const timestampHeader = String(options.timestampHeader || "x-pms-timestamp").toLowerCase();
  const prefix = typeof options.signaturePrefix === "string" ? options.signaturePrefix : "";
  const maxSkewSeconds = Number.isInteger(options.maxSkewSeconds) ? options.maxSkewSeconds : 300;
  if (!/^[a-z0-9-]{1,80}$/.test(signatureHeader) || !/^[a-z0-9-]{1,80}$/.test(timestampHeader) ||
      !Number.isInteger(maxSkewSeconds) || maxSkewSeconds < 30 || maxSkewSeconds > 600) {
    throw new PmsIntegrationError("INVALID_VERIFIER_CONFIG", "HMAC verifier configuration is invalid.");
  }
  return ({ headers, rawBody, secret, receivedAt = new Date() }) => {
    if (!headers || !Buffer.isBuffer(rawBody) || typeof secret !== "string" || secret.length < 16) return false;
    const header = name => {
      const key = Object.keys(headers).find(k => k.toLowerCase() === name);
      return key ? String(headers[key]) : "";
    };
    const timestampText = header(timestampHeader);
    if (!/^\d{10}$/.test(timestampText)) return false;
    const timestamp = Number(timestampText);
    const nowMs = receivedAt instanceof Date ? receivedAt.getTime() : Date.parse(receivedAt);
    if (!Number.isFinite(nowMs) || Math.abs(Math.floor(nowMs / 1000) - timestamp) > maxSkewSeconds) return false;
    const suppliedText = header(signatureHeader);
    if (!suppliedText.startsWith(prefix)) return false;
    const supplied = suppliedText.slice(prefix.length);
    if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
    const signed = Buffer.concat([Buffer.from(timestampText + ".", "utf8"), rawBody]);
    const expected = crypto.createHmac("sha256", secret).update(signed).digest();
    const actual = Buffer.from(supplied, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  };
}

function normalizeWebhookEvent(value, now = new Date()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PmsIntegrationError("INVALID_WEBHOOK_EVENT", "Provider webhook event must be an object.");
  }
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  const eventType = typeof value.eventType === "string" ? value.eventType.trim().toLowerCase() : "";
  const occurredAt = typeof value.occurredAt === "string" ? value.occurredAt : "";
  const data = value.data;
  const timestamp = Date.parse(occurredAt);
  const current = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!eventId || eventId.length > 200 || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(eventType) ||
      !Number.isFinite(timestamp) || !Number.isFinite(current) || timestamp > current + 5 * 60 * 1000 ||
      timestamp < current - 30 * 24 * 60 * 60 * 1000 ||
      !data || typeof data !== "object" || Array.isArray(data)) {
    throw new PmsIntegrationError("INVALID_WEBHOOK_EVENT", "Provider webhook event fields are invalid or outside the accepted time window.");
  }
  let serialized;
  try { serialized = JSON.stringify(data); } catch {
    throw new PmsIntegrationError("INVALID_WEBHOOK_EVENT", "Provider webhook event data is not serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    throw new PmsIntegrationError("WEBHOOK_EVENT_TOO_LARGE", "Provider webhook event data exceeds the 16 KB limit.", 413);
  }
  return { eventId, eventType, occurredAt: new Date(timestamp).toISOString(), data };
}

async function recordWebhookEvent(db, organizationId, provider, event, receivedAt = new Date()) {
  if (!db || typeof db.query !== "function" || typeof organizationId !== "string" || !organizationId ||
      !PROVIDER_KEY.test(provider || "")) {
    throw new PmsIntegrationError("INVALID_WEBHOOK_CONTEXT", "Webhook event context is incomplete.");
  }
  const normalized = normalizeWebhookEvent(event, receivedAt);
  const payloadHash = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const result = await db.query(
    "INSERT INTO pms_webhook_events(organization_id,provider,external_event_id,event_type,payload_sha256,received_at,status) VALUES($1,$2,$3,$4,$5,$6,'received') ON CONFLICT(organization_id,provider,external_event_id) DO NOTHING RETURNING id",
    [organizationId, provider, normalized.eventId, normalized.eventType, payloadHash, receivedAt],
  );
  return { accepted: result.rowCount === 1, duplicate: result.rowCount !== 1, eventId: normalized.eventId };
}

function createPmsRegistry(adapters = []) {
  const registered = new Map();
  function register(adapter) {
    if (!adapter || typeof adapter !== "object" || !PROVIDER_KEY.test(adapter.id || "") ||
        typeof adapter.name !== "string" || !adapter.name.trim() ||
        !adapter.capabilities || typeof adapter.capabilities !== "object" ||
        typeof adapter.testConnection !== "function") {
      throw new PmsIntegrationError("INVALID_ADAPTER", "PMS adapter does not implement the required contract.");
    }
    if (registered.has(adapter.id)) throw new PmsIntegrationError("DUPLICATE_ADAPTER", "PMS adapter is already registered.");
    registered.set(adapter.id, Object.freeze({
      id: adapter.id,
      name: adapter.name.trim(),
      mode: adapter.mode === "sandbox" ? "sandbox" : "production",
      capabilities: Object.freeze({
        availability: adapter.capabilities.availability === true && typeof adapter.getAvailability === "function",
        booking: adapter.capabilities.booking === true && typeof adapter.createBooking === "function",
        webhooks: adapter.capabilities.webhooks === true && typeof adapter.verifyWebhook === "function",
      }),
      testConnection: adapter.testConnection,
      getAvailability: adapter.getAvailability,
      createBooking: adapter.createBooking,
      verifyWebhook: adapter.verifyWebhook,
    }));
  }
  for (const adapter of adapters) register(adapter);

  function get(provider) {
    const adapter = registered.get(provider);
    if (!adapter) throw new PmsIntegrationError("PROVIDER_UNAVAILABLE", "This PMS provider has no installed adapter.", 404);
    return adapter;
  }
  return Object.freeze({
    register,
    list: () => [...registered.values()].map(({ id, name, mode, capabilities }) => ({ id, name, mode, capabilities })),
    testConnection: async provider => {
      const adapter = get(provider);
      const result = await adapter.testConnection();
      if (!result || result.ok !== true) throw new PmsIntegrationError("CONNECTION_TEST_FAILED", "PMS provider connection test failed.", 502);
      return { provider: adapter.id, providerName: adapter.name, mode: adapter.mode, ok: true, productionReady: adapter.mode === "production" };
    },
    getAvailability: async (provider, input) => {
      const adapter = get(provider);
      if (!adapter.capabilities.availability) throw new PmsIntegrationError("CAPABILITY_UNAVAILABLE", "This provider adapter does not support availability lookup.", 409);
      const dates = validateDateRange(input);
      const rows = await adapter.getAvailability(dates);
      if (!Array.isArray(rows) || rows.length > 200) throw new PmsIntegrationError("INVALID_PROVIDER_RESPONSE", "Provider returned an invalid availability list.", 502);
      return rows.map(normalizeAvailability);
    },
    createBooking: async (provider, input) => {
      const adapter = get(provider);
      if (!adapter.capabilities.booking) throw new PmsIntegrationError("CAPABILITY_UNAVAILABLE", "This provider adapter does not support booking creation.", 409);
      const request = normalizeBookingRequest(input);
      return normalizeBooking(await adapter.createBooking(request));
    },
    verifyWebhook: async (provider, input) => {
      const adapter = get(provider);
      if (!adapter.capabilities.webhooks) throw new PmsIntegrationError("CAPABILITY_UNAVAILABLE", "This provider adapter does not support webhooks.", 409);
      if (!input || !Buffer.isBuffer(input.rawBody) || !input.headers || typeof input.secret !== "string" || input.secret.length < 16) {
        throw new PmsIntegrationError("INVALID_WEBHOOK_CONTEXT", "Webhook verification requires the original request body, headers and configured provider secret.");
      }
      const verification = await adapter.verifyWebhook({ headers: input.headers, rawBody: input.rawBody, secret: input.secret, receivedAt: input.receivedAt || new Date() });
      if (!verification || verification.verified !== true) throw new PmsIntegrationError("INVALID_WEBHOOK_SIGNATURE", "Provider webhook signature could not be verified.", 401);
      return normalizeWebhookEvent(verification.event, input.receivedAt || new Date());
    },
  });
}

function createSandboxAdapter() {
  return {
    id: "sandbox",
    name: "Veyra PMS adapter sandbox",
    mode: "sandbox",
    capabilities: { availability: true, booking: false, webhooks: false },
    async testConnection() { return { ok: true, mode: "sandbox" }; },
    async getAvailability() { return []; },
  };
}

module.exports = {
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
};
