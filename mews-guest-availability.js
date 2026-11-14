"use strict";

const { getMewsRoomNightSnapshots } = require("./mews-live-context");
const { buildLiveHotelContext } = require("./hotel-live-context");

const UNAVAILABLE_CONTEXT =
  "ROOM AVAILABILITY: No verified, currently valid Mews connection is configured for this hotel. " +
  "Do not state or imply that rooms are available; offer staff assistance.";

function unavailable(reason) {
  return Object.freeze({
    connected: false,
    hasAvailableRooms: false,
    reason,
    snapshots: [],
    context: UNAVAILABLE_CONTEXT,
    availabilityCount: 0,
    availabilityFreshUntil: null
  });
}

/**
 * Resolve and query only the PMS connection belonging to the current tenant.
 * The resolver must be backed by an authorised, server-side secret store.
 * This module deliberately does not read global Mews credentials from env vars.
 */
async function buildMewsGuestAvailabilityContext({
  organizationId,
  resolveConnection,
  firstTimeUnitStartUtc,
  lastTimeUnitStartUtc,
  nowUtc = new Date().toISOString()
} = {}) {
  if (typeof organizationId !== "string" || !organizationId.trim()) {
    throw new Error("organizationId is required.");
  }
  if (typeof resolveConnection !== "function") {
    throw new Error("A tenant-scoped connection resolver is required.");
  }

  let connection;
  try {
    connection = await resolveConnection(organizationId);
  } catch {
    return unavailable("connection_lookup_failed");
  }
  if (!connection) return unavailable("not_configured");
  if (connection.organizationId !== organizationId) {
    return unavailable("tenant_mismatch");
  }
  if (!connection.client || !connection.service || !connection.propertyReference || !connection.timeZone) {
    return unavailable("incomplete_connection");
  }

  try {
    const snapshots = await getMewsRoomNightSnapshots({
      client: connection.client,
      service: connection.service,
      propertyReference: connection.propertyReference,
      timeZone: connection.timeZone,
      firstTimeUnitStartUtc,
      lastTimeUnitStartUtc,
      nowUtc
    });
    const live = buildLiveHotelContext({ availabilitySnapshots: snapshots, nowUtc });
    return Object.freeze({
      connected: true,
      hasAvailableRooms: snapshots.some((snapshot) => snapshot.roomsAvailable > 0),
      reason: null,
      snapshots,
      context: live.context,
      availabilityCount: live.availabilityCount,
      availabilityFreshUntil: live.availabilityFreshUntil
    });
  } catch {
    // Provider errors and malformed data must never become guest-facing facts.
    return unavailable("provider_unavailable");
  }
}

module.exports = { buildMewsGuestAvailabilityContext };
