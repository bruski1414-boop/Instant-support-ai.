"use strict";

/**
 * Server-side, read-only transport for Oracle Hospitality Integration
 * Platform (OHIP). Includes the documented OPERA Cloud v1 availability route;
 * it does not acquire tokens or infer hotel-specific room/rate mappings.
 *
 * The hotel/vendor-approved token provider and credentials must be supplied
 * by trusted server configuration / a credential vault, never by a guest.
 */
function requiredText(value, field, max = 2048) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(field + " is required.");
  }
  return value.trim();
}

function createOperaOhipReadOnlyClient({
  gatewayUrl,
  appKey,
  hotelId,
  getAccessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  maxResponseBytes = 2 * 1024 * 1024
} = {}) {
  const gateway = requiredText(gatewayUrl, "gatewayUrl");
  let base;
  try {
    base = new URL(gateway);
  } catch {
    throw new Error("gatewayUrl must be a valid HTTPS URL.");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("gatewayUrl must be HTTPS and must not contain credentials, query, or fragment.");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";

  const safeAppKey = requiredText(appKey, "appKey", 512);
  const safeHotelId = requiredText(hotelId, "hotelId", 128);
  if (typeof getAccessToken !== "function") throw new Error("A server-side access-token provider is required.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error("timeoutMs must be from 1000 to 60000.");
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 10 * 1024 * 1024) {
    throw new Error("maxResponseBytes must be from 1024 to 10485760.");
  }

  return Object.freeze({
    providerId: "oracle_opera",
    readOnly: true,

    async getHotelAvailability({
      roomStayStartDate, roomStayEndDate, adults, children = 0,
      roomStayQuantity = 1, limit = 10, ratePlanCode, roomType
    } = {}) {
      const validDate = (value, field) => {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          throw new Error(field + " must use YYYY-MM-DD.");
        }
        const parsed = new Date(value + "T00:00:00.000Z");
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
          throw new Error(field + " must be a real calendar date.");
        }
        return value;
      };
      const start = validDate(roomStayStartDate, "roomStayStartDate");
      const end = validDate(roomStayEndDate, "roomStayEndDate");
      if (end <= start) throw new Error("roomStayEndDate must be after roomStayStartDate.");
      if (!Number.isInteger(adults) || adults < 1 || adults > 20) throw new Error("adults must be from 1 to 20.");
      if (!Number.isInteger(children) || children < 0 || children > 20) throw new Error("children must be from 0 to 20.");
      if (!Number.isInteger(roomStayQuantity) || roomStayQuantity < 1 || roomStayQuantity > 10) {
        throw new Error("roomStayQuantity must be from 1 to 10.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be from 1 to 100.");
      const query = { roomStayStartDate: start, roomStayEndDate: end, adults, children, roomStayQuantity, limit };
      if (ratePlanCode != null) query.ratePlanCode = requiredText(ratePlanCode, "ratePlanCode", 80);
      if (roomType != null) query.roomType = requiredText(roomType, "roomType", 80);
      return this.get({
        path: "/par/v1/hotels/" + encodeURIComponent(safeHotelId) + "/availability",
        query
      });
    },

    async get({ path, query } = {}) {
      const safePath = requiredText(path, "path", 1024);
      if (!safePath.startsWith("/") || safePath.startsWith("//") ||
          safePath.includes("\\") || /[\u0000-\u001f\u007f]/.test(safePath)) {
        throw new Error("path must be an absolute API path on the configured OHIP gateway.");
      }
      const target = new URL(safePath.slice(1), base);
      if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
        throw new Error("API path must remain within the configured OHIP gateway.");
      }
      if (query != null) {
        if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("query must be an object.");
        for (const [key, value] of Object.entries(query)) {
          if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key) ||
              !(typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
            throw new Error("query contains an invalid parameter.");
          }
          target.searchParams.set(key, String(value));
        }
      }

      const token = requiredText(await getAccessToken(), "access token", 8192);
      if (/\s/.test(token)) throw new Error("Access-token provider returned an invalid token.");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(target.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer " + token,
            "x-app-key": safeAppKey,
            "x-hotelid": safeHotelId
          },
          signal: controller.signal
        });
        if (!response || typeof response.status !== "number") {
          throw new Error("OHIP returned an invalid HTTP response.");
        }
        if (!response.ok) {
          // Do not include provider response bodies or credentials in errors/logs.
          throw new Error("OHIP read request failed with HTTP " + response.status + ".");
        }
        if (response.status === 204) return null;
        const raw = await response.text();
        if (Buffer.byteLength(raw, "utf8") > maxResponseBytes) {
          throw new Error("OHIP response exceeded the configured size limit.");
        }
        try {
          return JSON.parse(raw);
        } catch {
          throw new Error("OHIP returned a non-JSON response.");
        }
      } catch (error) {
        if (error && error.name === "AbortError") throw new Error("OHIP request timed out.");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  });
}

module.exports = { createOperaOhipReadOnlyClient };
