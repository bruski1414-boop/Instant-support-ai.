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
  const guestInput = input.guest;
  const guestName = typeof guestInput?.name === "string" ? guestInput.name.trim().replace(/\s+/g, " ") : "";
  const guestPhone = typeof guestInput?.phone === "string" ? guestInput.phone.trim() : "";
  const guestEmail = typeof guestInput?.email === "string" ? guestInput.email.trim().toLowerCase() : "";
  if (guestName.length < 2 || guestName.length > 120 || /[<>\u0000-\u001f]/.test(guestName) ||
      !/^\+[1-9]\d{7,14}$/.test(guestPhone.replace(/[\s().-]/g, "")) ||
      (guestEmail && (guestEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)))) {
    throw new PmsIntegrationError("INVALID_GUEST_DETAILS", "A valid guest name and international phone number are required.");
  }
  const totalAmountMinor = input.totalAmountMinor;
  const depositAmountMinor = input.depositAmountMinor;
  const currency = typeof input.currency === "string" ? input.currency : "";
  if (input.depositVerified !== true || !Number.isSafeInteger(totalAmountMinor) || totalAmountMinor <= 0 ||
      !Number.isSafeInteger(depositAmountMinor) || depositAmountMinor !== Math.ceil(totalAmountMinor / 2) ||
      !CURRENCIES.test(currency) || input.paidAmountMinor !== depositAmountMinor ||
      input.paidCurrency !== currency) {
    throw new PmsIntegrationError("VERIFIED_DEPOSIT_REQUIRED", "A matching, verified 50% deposit is required before creating the PMS reservation.", 409);
  }
  return { ...dates, roomTypeId, guestCount, idempotencyKey, guest: {
    name: guestName, phone: guestPhone.replace(/[\s().-]/g, ""), email: guestEmail || null,
  }, totalAmountMinor, depositAmountMinor, currency, depositVerified: true };
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
  if (result.rowCount === 1) {
    return { accepted: true, duplicate: false, eventId: normalized.eventId };
  }
  const existing = await db.query(
    "SELECT payload_sha256 FROM pms_webhook_events WHERE organization_id=$1 AND provider=$2 AND external_event_id=$3",
    [organizationId, provider, normalized.eventId],
  );
  if (!existing.rowCount || existing.rows[0].payload_sha256 !== payloadHash) {
    throw new PmsIntegrationError(
      "WEBHOOK_EVENT_ID_COLLISION",
      "Provider reused an event ID with different event data.",
      409,
    );
  }
  return { accepted: false, duplicate: true, eventId: normalized.eventId };
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
    if (adapter.mode !== "sandbox" && typeof adapter.validateCredentials !== "function") {
      throw new PmsIntegrationError("INVALID_ADAPTER", "Production PMS adapters must validate credentials before use.");
    }
    registered.set(adapter.id, Object.freeze({
      id: adapter.id,
      name: adapter.name.trim(),
      mode: adapter.mode === "sandbox" ? "sandbox" : "production",
      validateCredentials: adapter.validateCredentials,
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
    validateCredentials: async (provider, input) => {
      const adapter = get(provider);
      if (typeof adapter.validateCredentials !== "function") throw new PmsIntegrationError("CREDENTIAL_VALIDATION_UNAVAILABLE", "This adapter does not accept hotel credentials.", 409);
      let result;
      try {
        result = await adapter.validateCredentials(input);
      } catch {
        throw new PmsIntegrationError("INVALID_CREDENTIALS", "Provider adapter rejected the supplied connection details.");
      }
      if (!result || typeof result !== "object" || Array.isArray(result) ||
          !result.credentials || typeof result.credentials !== "object" || Array.isArray(result.credentials) ||
          !Array.isArray(result.scopes) || result.scopes.some(scope => typeof scope !== "string" || !/^[a-zA-Z0-9:._-]{1,100}$/.test(scope))) {
        throw new PmsIntegrationError("INVALID_CREDENTIALS", "Provider adapter rejected the supplied connection details.");
      }
      return { credentials: result.credentials, scopes: [...new Set(result.scopes)] };
    },
    testConnection: async (provider, context = {}) => {
      const adapter = get(provider);
      const result = await adapter.testConnection(context);
      if (!result || result.ok !== true) throw new PmsIntegrationError("CONNECTION_TEST_FAILED", "PMS provider connection test failed.", 502);
      return { provider: adapter.id, providerName: adapter.name, mode: adapter.mode, ok: true, productionReady: adapter.mode === "production" };
    },
    getAvailability: async (provider, input, context = {}) => {
      const adapter = get(provider);
      if (!adapter.capabilities.availability) throw new PmsIntegrationError("CAPABILITY_UNAVAILABLE", "This provider adapter does not support availability lookup.", 409);
      const dates = validateDateRange(input);
      const guestCount = input.guestCount === undefined ? 1 : input.guestCount;
      if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20) {
        throw new PmsIntegrationError("INVALID_GUEST_COUNT", "Guest count must be between 1 and 20.");
      }
      const rows = await adapter.getAvailability({ ...dates, guestCount }, context);
      if (!Array.isArray(rows) || rows.length > 200) throw new PmsIntegrationError("INVALID_PROVIDER_RESPONSE", "Provider returned an invalid availability list.", 502);
      return rows.map(normalizeAvailability);
    },
    createBooking: async (provider, input, context = {}) => {
      const adapter = get(provider);
      if (!adapter.capabilities.booking) throw new PmsIntegrationError("CAPABILITY_UNAVAILABLE", "This provider adapter does not support booking creation.", 409);
      const request = normalizeBookingRequest(input);
      return normalizeBooking(await adapter.createBooking(request, context));
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



function localDateTimeToUtc(date, time, timeZone) {
  if (typeof date !== "string" || typeof time !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time) ||
      typeof timeZone !== "string" || !timeZone.trim()) {
    throw new PmsIntegrationError("INVALID_LOCAL_DATETIME", "A valid local date, time and IANA time zone are required.");
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(desired) || new Date(desired).toISOString().slice(0, 10) !== date) {
    throw new PmsIntegrationError("INVALID_LOCAL_DATETIME", "The local date is invalid.");
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formatter.format(new Date(desired));
  } catch {
    throw new PmsIntegrationError("INVALID_TIME_ZONE", "The hotel's IANA time zone is invalid.");
  }
  let candidate = desired;
  for (let i = 0; i < 4; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate += desired - represented;
  }
  const finalParts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
    .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  if (finalParts.year !== year || finalParts.month !== month || finalParts.day !== day ||
      finalParts.hour !== hour || finalParts.minute !== minute || finalParts.second !== second) {
    throw new PmsIntegrationError("INVALID_LOCAL_DATETIME", "The requested local time does not exist in the hotel's time zone.");
  }
  return new Date(candidate).toISOString();
}

function createMewsConnectorAdapter(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const platformAddress = String(options.platformAddress || "https://api.mews.com").replace(/\/$/, "");
  const clientName = String(options.clientName || "Veyra AI/1.0.0");
  if (typeof fetchImpl !== "function" || !/^https:\/\//.test(platformAddress) ||
      !clientName || clientName.length > 100) {
    throw new PmsIntegrationError("INVALID_MEWS_CONFIG", "Mews connector configuration is invalid.");
  }

  function credentials(input = {}) {
    const clientToken = typeof input.clientToken === "string" ? input.clientToken.trim() : "";
    const accessToken = typeof input.accessToken === "string" ? input.accessToken.trim() : "";
    if (!clientToken || !accessToken) {
      throw new PmsIntegrationError("INVALID_CREDENTIALS", "Mews Client Token and Access Token are required.");
    }
    return { clientToken, accessToken };
  }

  async function call(path, input, auth) {
    let response;
    try {
      response = await fetchImpl(platformAddress + "/api/connector/v1/" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ClientToken: auth.clientToken,
          AccessToken: auth.accessToken,
          Client: clientName,
          ...input,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new PmsIntegrationError("MEWS_UNAVAILABLE", "Mews could not be reached. No booking confirmation was issued.", 502);
    }
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || !body || body.Message || body.ErrorCode) {
      throw new PmsIntegrationError("MEWS_REQUEST_FAILED", "Mews rejected the request. Check the hotel's integration configuration and permissions.", 502);
    }
    return body;
  }

  function authFromContext(context = {}) {
    const auth = credentials(context.credentials || {});
    return auth;
  }

  return {
    id: "mews",
    name: "Mews Connector API",
    mode: "production",
    capabilities: { availability: true, booking: true, webhooks: false },
    async getAvailability(dates, context = {}) {
      const auth = authFromContext(context);
      const config = context.propertyConfig || {};
      const serviceId = String(config.serviceId || "").trim();
      const timeZone = String(config.timeZone || "").trim();
      const timeUnitPeriod = String(config.timeUnitPeriod || "");
      const checkInTime = String(config.checkInTime || "14:00:00");
      const checkOutTime = String(config.checkOutTime || "10:00:00");
      const roomTypes = Array.isArray(config.roomTypes) ? config.roomTypes :
        (config.requestedCategoryId ? [{
          roomTypeId: config.roomTypeId || config.requestedCategoryId,
          roomTypeName: config.roomTypeName,
          rateId: config.rateId,
          requestedCategoryId: config.requestedCategoryId,
          adultAgeCategoryId: config.adultAgeCategoryId,
          maxOccupancy: config.maxOccupancy,
        }] : []);
      if (!serviceId || !timeZone || timeUnitPeriod !== "Day" ||
          !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(checkInTime) ||
          !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(checkOutTime) ||
          !Array.isArray(roomTypes) || roomTypes.length < 1 || roomTypes.length > 20) {
        throw new PmsIntegrationError("MEWS_PROPERTY_MAPPING_REQUIRED",
          "The hotel must configure a Mews accommodation service, IANA time zone, daily service period, local check-in/out times and at least one room/rate mapping.", 409);
      }
      const normalizedRooms = roomTypes.map(room => ({
        roomTypeId: String(room?.roomTypeId || "").trim(),
        roomTypeName: String(room?.roomTypeName || "").trim(),
        rateId: String(room?.rateId || "").trim(),
        requestedCategoryId: String(room?.requestedCategoryId || "").trim(),
        adultAgeCategoryId: String(room?.adultAgeCategoryId || "").trim(),
        maxOccupancy: Number(room?.maxOccupancy),
      }));
      const seenRoomIds = new Set();
      const seenCategoryIds = new Set();
      for (const room of normalizedRooms) {
        if (!room.roomTypeId || room.roomTypeId.length > 120 ||
            !room.roomTypeName || room.roomTypeName.length > 160 ||
            !room.rateId || !room.requestedCategoryId || !room.adultAgeCategoryId ||
            !Number.isInteger(room.maxOccupancy) || room.maxOccupancy < 1 || room.maxOccupancy > 20 ||
            seenRoomIds.has(room.roomTypeId) || seenCategoryIds.has(room.requestedCategoryId)) {
          throw new PmsIntegrationError("MEWS_PROPERTY_MAPPING_REQUIRED",
            "Every room mapping needs unique room and category IDs, a display name, rate, adult age category and maximum occupancy.", 409);
        }
        seenRoomIds.add(room.roomTypeId);
        seenCategoryIds.add(room.requestedCategoryId);
      }
      const guestCount = dates.guestCount || 1;
      if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 20) {
        throw new PmsIntegrationError("INVALID_GUEST_COUNT", "Guest count must be between 1 and 20.");
      }
      const eligibleRooms = normalizedRooms.filter(room => guestCount <= room.maxOccupancy);
      if (!eligibleRooms.length) {
        throw new PmsIntegrationError("GUEST_COUNT_EXCEEDS_ROOM_CAPACITY",
          "No configured room type can accommodate the requested guest count.", 400);
      }

      const lastOccupiedDate = new Date(Date.parse(dates.checkOut + "T00:00:00.000Z") - 86400000)
        .toISOString().slice(0, 10);
      const firstUnitUtc = localDateTimeToUtc(dates.checkIn, "00:00:00", timeZone);
      const lastUnitUtc = localDateTimeToUtc(lastOccupiedDate, "00:00:00", timeZone);
      const availability = await call("services/getAvailability", {
        ServiceId: serviceId,
        FirstTimeUnitStartUtc: firstUnitUtc,
        LastTimeUnitStartUtc: lastUnitUtc,
      }, auth);
      const categories = Array.isArray(availability.CategoryAvailabilities)
        ? availability.CategoryAvailabilities : [];
      const starts = availability.TimeUnitStartsUtc;
      const expectedNights = Math.round(
        (Date.parse(dates.checkOut + "T00:00:00.000Z") -
         Date.parse(dates.checkIn + "T00:00:00.000Z")) / 86400000
      );
      if (!Array.isArray(starts) || starts.length !== expectedNights) {
        throw new PmsIntegrationError("MEWS_AVAILABILITY_UNVERIFIED",
          "Mews did not return a complete availability calendar for every night.", 502);
      }
      for (let index = 0; index < expectedNights; index += 1) {
        const expectedDate = new Date(Date.parse(dates.checkIn + "T00:00:00.000Z") + index * 86400000)
          .toISOString().slice(0, 10);
        const expectedUtc = localDateTimeToUtc(expectedDate, "00:00:00", timeZone);
        if (!starts[index] || Date.parse(starts[index]) !== Date.parse(expectedUtc)) {
          throw new PmsIntegrationError("MEWS_AVAILABILITY_UNVERIFIED",
            "Mews returned mismatched or invalid daily availability dates.", 502);
        }
      }

      const availableRooms = [];
      for (const room of eligibleRooms) {
        const category = categories.find(item => item && item.CategoryId === room.requestedCategoryId);
        if (!category || !Array.isArray(category.Availabilities) ||
            !Array.isArray(category.Adjustments) ||
            category.Availabilities.length !== expectedNights ||
            category.Adjustments.length !== expectedNights) {
          throw new PmsIntegrationError("MEWS_AVAILABILITY_UNVERIFIED",
            "Mews did not return complete inventory for every configured room type.", 502);
        }
        const adjustedAvailabilities = category.Availabilities.map((absolute, index) => {
          const adjustment = category.Adjustments[index];
          if (!Number.isSafeInteger(absolute) || absolute < 0 || !Number.isSafeInteger(adjustment)) {
            throw new PmsIntegrationError("MEWS_AVAILABILITY_UNVERIFIED",
              "Mews returned invalid inventory values. No availability claim can be made.", 502);
          }
          return Math.max(0, absolute + adjustment);
        });
        const availableUnits = Math.min(...adjustedAvailabilities);
        if (availableUnits > 0) availableRooms.push({ ...room, availableUnits });
      }
      if (!availableRooms.length) return [];

      const quoteRequests = availableRooms.map((room, index) => ({
        Identifier: "veyra-quote-" + index,
        StartUtc: localDateTimeToUtc(dates.checkIn, checkInTime, timeZone),
        EndUtc: localDateTimeToUtc(dates.checkOut, checkOutTime, timeZone),
        RequestedCategoryId: room.requestedCategoryId,
        RateId: room.rateId,
        PersonCounts: [{ AgeCategoryId: room.adultAgeCategoryId, Count: guestCount }],
      }));
      const quote = await call("reservations/price", {
        ServiceId: serviceId,
        Reservations: quoteRequests,
      }, auth);
      const prices = Array.isArray(quote.ReservationPrices) ? quote.ReservationPrices : [];
      if (prices.length !== availableRooms.length) {
        throw new PmsIntegrationError("MEWS_PRICE_UNVERIFIED",
          "Mews did not return a price for every available room type.", 502);
      }
      return availableRooms.map((room, index) => {
        const identifier = "veyra-quote-" + index;
        const price = prices.find(item => item && item.Identifier === identifier);
        const total = price && price.TotalAmount;
        const currency = total && typeof total.Currency === "string" ? total.Currency.toUpperCase() : "";
        if (!price || !total || !/^[A-Z]{3}$/.test(currency) ||
            typeof total.GrossValue !== "number" || !Number.isFinite(total.GrossValue) ||
            total.GrossValue < 0 || !Array.isArray(price.AdditionalExpenses)) {
          throw new PmsIntegrationError("MEWS_PRICE_UNVERIFIED",
            "Mews did not return a complete gross reservation price. No price can be quoted.", 502);
        }
        let grossTotal = total.GrossValue;
        for (const expense of price.AdditionalExpenses) {
          const amount = expense && expense.Amount;
          if (!amount || String(amount.Currency || "").toUpperCase() !== currency ||
              typeof amount.GrossValue !== "number" || !Number.isFinite(amount.GrossValue)) {
            throw new PmsIntegrationError("MEWS_PRICE_UNVERIFIED",
              "Mews returned an incomplete or mixed-currency additional expense. No price can be quoted.", 502);
          }
          grossTotal += amount.GrossValue;
        }
        const fractionDigits = new Intl.NumberFormat("en", {
          style: "currency", currency,
        }).resolvedOptions().maximumFractionDigits;
        const amountMinor = Math.round(grossTotal * (10 ** fractionDigits));
        if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 ||
            Math.abs(grossTotal * (10 ** fractionDigits) - amountMinor) > 0.00001) {
          throw new PmsIntegrationError("MEWS_PRICE_UNVERIFIED",
            "Mews returned a price that cannot be represented safely in the hotel's currency.", 502);
        }
        return {
          roomTypeId: room.roomTypeId,
          roomTypeName: room.roomTypeName,
          currency,
          amountMinor,
          availableUnits: room.availableUnits,
        };
      });
    },
    async validateCredentials(input) {
      const auth = credentials(input);
      await call("services/getAll", { Limitation: { Count: 1 } }, auth);
      return { credentials: auth, scopes: ["availability:read", "reservations:price", "reservations:create", "customers:create"] };
    },
    async testConnection(context = {}) {
      const auth = authFromContext(context);
      await call("services/getAll", { Limitation: { Count: 1 } }, auth);
      return { ok: true, mode: "production" };
    },
    async createBooking(request, context = {}) {
      const auth = authFromContext(context);
      const config = context.propertyConfig || {};
      const serviceId = String(config.serviceId || "").trim();
      const roomTypes = Array.isArray(config.roomTypes) ? config.roomTypes : [];
      const selectedRoom = roomTypes.find(room => room && room.roomTypeId === request.roomTypeId);
      const rateId = String(selectedRoom?.rateId || config.rateId || "").trim();
      const requestedCategoryId = String(selectedRoom?.requestedCategoryId || config.requestedCategoryId || request.roomTypeId || "").trim();
      const adultAgeCategoryId = String(selectedRoom?.adultAgeCategoryId || config.adultAgeCategoryId || "").trim();
      const maxOccupancy = Number(selectedRoom?.maxOccupancy || config.maxOccupancy || 20);
      const checkInTime = String(config.checkInTime || "14:00:00");
      const checkOutTime = String(config.checkOutTime || "10:00:00");
      const timeZone = String(config.timeZone || "").trim();
      const enterpriseId = config.enterpriseId ? String(config.enterpriseId) : undefined;
      if (!serviceId || !rateId || !requestedCategoryId || !adultAgeCategoryId || !timeZone ||
          !Number.isInteger(maxOccupancy) || maxOccupancy < 1 || maxOccupancy > 20 ||
          request.guestCount > maxOccupancy ||
          !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(checkInTime) ||
          !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(checkOutTime)) {
        throw new PmsIntegrationError("MEWS_PROPERTY_MAPPING_REQUIRED", "The hotel must map its Mews service, rate, room category, adult age category, IANA time zone and local check-in/out times before bookings can be created.", 409);
      }
      const [firstName, ...lastParts] = request.guest.name.split(" ");
      const lastName = lastParts.join(" ") || firstName;
      const channelNumber = request.idempotencyKey.slice(0, 50);
      const priorResponse = await call("reservations/getAll/2023-06-06", {
        ServiceIds: [serviceId],
        ChannelNumbers: [channelNumber],
        Limitation: { Count: 5 },
      }, auth);
      const prior = Array.isArray(priorResponse.Reservations)
        ? priorResponse.Reservations.find(item => item && item.ChannelNumber === channelNumber)
        : null;
      if (prior) {
        const priorState = String(prior.State || "").toLowerCase();
        const priorStatus = ({
          confirmed: "confirmed", optional: "pending", inquired: "pending",
          canceled: "cancelled", started: "checked_in", processed: "checked_out",
        })[priorState];
        if (!prior.Id || !priorStatus || priorStatus === "cancelled") {
          throw new PmsIntegrationError("MEWS_IDEMPOTENCY_CONFLICT", "This booking request key already exists in Mews and cannot safely be reused.", 409);
        }
        return { bookingId: prior.Id, status: priorStatus, customerId: prior.AccountId || null, confirmationNumber: prior.Number || null };
      }
      const customerPayload = {
        FirstName: firstName,
        LastName: lastName,
        Phone: request.guest.phone,
        OverwriteExisting: false,
      };
      if (request.guest.email) customerPayload.Email = request.guest.email;
      const customer = await call("customers/add", customerPayload, auth);
      if (!customer || typeof customer.Id !== "string" || !customer.Id) {
        throw new PmsIntegrationError("MEWS_INVALID_CUSTOMER_RESPONSE", "Mews did not return a customer profile ID.", 502);
      }
      const reservation = {
        ServiceId: serviceId,
        SendConfirmationEmail: false,
        Reservations: [{
          State: "Confirmed",
          StartUtc: localDateTimeToUtc(request.checkIn, checkInTime, timeZone),
          EndUtc: localDateTimeToUtc(request.checkOut, checkOutTime, timeZone),
          CustomerId: customer.Id,
          RequestedCategoryId: requestedCategoryId,
          RateId: rateId,
          PersonCounts: [{ AgeCategoryId: adultAgeCategoryId, Count: request.guestCount }],
          ChannelNumber: channelNumber,
        }],
      };
      if (enterpriseId) reservation.EnterpriseId = enterpriseId;
      const result = await call("reservations/add", reservation, auth);
      const added = Array.isArray(result.Reservations) ? result.Reservations[0] : null;
      const booking = added && added.Reservation ? added.Reservation : added;
      const bookingId = booking && (booking.Id || booking.Identifier);
      const rawState = booking && String(booking.State || "").toLowerCase();
      const status = ({
        confirmed: "confirmed", optional: "pending", inquired: "pending",
        canceled: "cancelled", started: "checked_in", processed: "checked_out",
      })[rawState];
      if (typeof bookingId !== "string" || !bookingId || !status || status !== "confirmed") {
        throw new PmsIntegrationError("MEWS_RESERVATION_UNVERIFIED", "Mews did not return a usable reservation record. Do not tell the guest the booking is confirmed.", 502);
      }
      return { bookingId, status, customerId: customer.Id, confirmationNumber: booking.Number || null };
    },
  };
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
  createMewsConnectorAdapter,
  localDateTimeToUtc,
  createSandboxAdapter,
};
