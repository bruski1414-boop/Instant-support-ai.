"use strict";

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
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(checkIn) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(checkOut)) {
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
  createPmsRegistry,
  createSandboxAdapter,
};
