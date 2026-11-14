"use strict";

const { normalizeAvailabilitySnapshot } = require("./pms-integration");

function safeText(value, field, max = 240) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(field + " must be a non-empty string of at most " + max + " characters.");
  }
  return value.trim();
}

function utcNow(value) {
  const input = value == null ? new Date().toISOString() : value;
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(input) || !Number.isFinite(Date.parse(input))) {
    throw new Error("nowUtc must be a valid ISO-8601 UTC timestamp.");
  }
  return new Date(input).toISOString();
}

function buildLiveHotelContext({ availabilitySnapshots = [], serviceInformation = [], nowUtc: suppliedNow } = {}) {
  if (!Array.isArray(availabilitySnapshots) || !Array.isArray(serviceInformation)) {
    throw new Error("Live availability and service information must be lists.");
  }
  if (availabilitySnapshots.length > 500 || serviceInformation.length > 100) {
    throw new Error("Live hotel context exceeds the permitted item limits.");
  }

  const now = utcNow(suppliedNow);
  const nowMs = Date.parse(now);
  const currentAvailability = [];
  for (const raw of availabilitySnapshots) {
    const snapshot = normalizeAvailabilitySnapshot(raw);
    const observed = Date.parse(snapshot.observedAt);
    const validUntil = Date.parse(snapshot.validUntil);
    if (observed > nowMs || validUntil <= nowMs) continue;
    currentAvailability.push(snapshot);
  }

  const services = serviceInformation.map((service) => {
    if (!service || typeof service !== "object" || Array.isArray(service)) {
      throw new Error("Each live hotel service must be an object.");
    }
    return {
      name: safeText(service.name, "service.name", 120),
      category: service.category == null ? "general" : safeText(service.category, "service.category", 80),
      status: service.status == null ? "information_only" : safeText(service.status, "service.status", 40),
      details: service.details == null ? null : safeText(service.details, "service.details", 600)
    };
  });

  const lines = [];
  if (services.length) {
    lines.push("LIVE HOTEL SERVICE INFORMATION (manager-approved; not a booking confirmation):");
    for (const service of services) {
      lines.push("- " + service.name + " [" + service.category + "; " + service.status + "]" +
        (service.details ? ": " + service.details : ""));
    }
  }
  if (currentAvailability.length) {
    lines.push("LIVE ROOM AVAILABILITY SNAPSHOTS (time-limited; not a reservation):");
    for (const item of currentAvailability) {
      lines.push("- Room type " + item.roomTypeCode + ", " + item.arrivalDate + " to " +
        item.departureDate + ": " + item.roomsAvailable + " room(s) reported available. " +
        "Observed " + item.observedAt + "; valid until " + item.validUntil + ".");
    }
  } else {
    lines.push("ROOM AVAILABILITY: No verified, currently valid availability snapshot is available. " +
      "Do not state or imply that rooms are available; offer staff assistance.");
  }

  const nextExpiry = currentAvailability.reduce((min, item) =>
    Math.min(min, Date.parse(item.validUntil)), Infinity);
  return Object.freeze({
    context: lines.join("\n"),
    availabilityCount: currentAvailability.length,
    serviceCount: services.length,
    availabilityFreshUntil: Number.isFinite(nextExpiry) ? new Date(nextExpiry).toISOString() : null,
    generatedAt: now
  });
}

module.exports = { buildLiveHotelContext };
