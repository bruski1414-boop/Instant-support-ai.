"use strict";

const { normalizeAvailabilitySnapshot } = require("./pms-integration");

function required(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(name + " is required.");
  }
  return value.trim();
}

function localCalendarDate(utcTimestamp, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date(utcTimestamp));
  } catch {
    throw new Error("A valid IANA property time zone is required.");
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function nextDate(date) {
  const value = new Date(date + "T00:00:00.000Z");
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function mapMewsAbsoluteAvailability({
  availability,
  service,
  propertyReference,
  timeZone,
  observedAt,
  validUntil
} = {}) {
  if (!availability || typeof availability !== "object" || Array.isArray(availability)) {
    throw new Error("Mews availability response is required.");
  }
  if (!service || typeof service !== "object" || Array.isArray(service)) {
    throw new Error("Mews service metadata is required.");
  }
  if (service.timeUnitPeriod !== "Day") {
    throw new Error("Only daily Mews accommodation services can be mapped to room-night snapshots.");
  }
  const property = required(propertyReference, "propertyReference");
  const serviceId = required(service.id, "service.id");
  const timeZoneName = required(timeZone, "timeZone");
  if (!Array.isArray(availability.timeUnitStartsUtc) ||
      !Array.isArray(availability.categoryAvailabilities)) {
    throw new Error("Mews availability response has an invalid shape.");
  }
  const times = availability.timeUnitStartsUtc;
  if (times.length > 367) throw new Error("Mews availability response exceeds the daily range limit.");
  const snapshots = [];
  for (const entry of availability.categoryAvailabilities) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Mews category availability entry is invalid.");
    }
    const categoryId = required(entry.categoryId, "categoryId");
    if (!Array.isArray(entry.availabilities) || entry.availabilities.length !== times.length) {
      throw new Error("Mews availability values must align with each returned time unit.");
    }
    for (let index = 0; index < times.length; index += 1) {
      const start = times[index];
      if (typeof start !== "string" || !Number.isFinite(Date.parse(start))) {
        throw new Error("Mews returned an invalid time-unit timestamp.");
      }
      const count = entry.availabilities[index];
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("Mews absolute availability must be a non-negative integer.");
      }
      const arrivalDate = localCalendarDate(start, timeZoneName);
      const snapshot = normalizeAvailabilitySnapshot({
        propertyReference: property,
        roomTypeCode: categoryId,
        arrivalDate,
        departureDate: nextDate(arrivalDate),
        roomsAvailable: count,
        observedAt,
        validUntil,
        sourceEventId: "mews:" + serviceId + ":" + categoryId + ":" + arrivalDate
      });
      snapshots.push(snapshot);
    }
  }
  return Object.freeze(snapshots);
}

async function getMewsRoomNightSnapshots({
  client,
  service,
  propertyReference,
  timeZone,
  firstTimeUnitStartUtc,
  lastTimeUnitStartUtc,
  nowUtc = new Date().toISOString()
} = {}) {
  if (!client || typeof client.getServiceAvailabilityAbsolute !== "function") {
    throw new Error("A read-only Mews client is required.");
  }
  if (typeof nowUtc !== "string" || !Number.isFinite(Date.parse(nowUtc))) {
    throw new Error("nowUtc must be a valid timestamp.");
  }
  const observedAt = new Date(nowUtc).toISOString();
  const validUntil = new Date(Date.parse(observedAt) + 10 * 60 * 1000).toISOString();
  const availability = await client.getServiceAvailabilityAbsolute({
    serviceId: service && service.id,
    firstTimeUnitStartUtc,
    lastTimeUnitStartUtc
  });
  return mapMewsAbsoluteAvailability({
    availability, service, propertyReference, timeZone, observedAt, validUntil
  });
}

module.exports = { mapMewsAbsoluteAvailability, getMewsRoomNightSnapshots };
