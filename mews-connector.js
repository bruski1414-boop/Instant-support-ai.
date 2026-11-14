"use strict";

// Read-only Mews Connector API client. Demo environment only until Veyra is
// registered/certified and a hotel explicitly authorizes a production connection.
const DEMO_BASE_URL = "https://api.mews-demo.com";
const DEFAULT_METRICS = [
  "ConfirmedReservations",
  "OptionalReservations",
  "Occupied",
  "UsableResources",
  "ActiveResources"
];

function nonEmpty(value, name, max = 240) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(name + " is required.");
  }
  return value.trim();
}

function validUtc(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(name + " must be a valid ISO-8601 UTC timestamp.");
  }
  return new Date(value).toISOString();
}

function createMewsConnectorClient({
  clientToken,
  accessToken,
  clientName = "Veyra AI/0.1",
  baseUrl = DEMO_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000
} = {}) {
  const safeClientToken = nonEmpty(clientToken, "MEWS_CLIENT_TOKEN", 500);
  const safeAccessToken = nonEmpty(accessToken, "MEWS_ACCESS_TOKEN", 500);
  const safeClientName = nonEmpty(clientName, "MEWS_CLIENT_NAME", 120);
  if (baseUrl !== DEMO_BASE_URL) {
    throw new Error("Only the official Mews demo environment is enabled in this build.");
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new Error("timeoutMs must be between 1000 and 30000.");
  }

  async function post(path, fields = {}) {
    if (!/^\/api\/connector\/v1\/[a-zA-Z0-9/]+$/.test(path)) throw new Error("Invalid Mews operation path.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(baseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          ClientToken: safeClientToken,
          AccessToken: safeAccessToken,
          Client: safeClientName,
          ...fields
        }),
        signal: controller.signal
      });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; }
      catch { throw new Error("Mews returned a non-JSON response."); }
      if (!response.ok) {
        const error = new Error("Mews Connector API request failed with HTTP " + response.status + ".");
        error.status = response.status;
        // Never include raw provider responses: they may contain property or guest data.
        throw error;
      }
      return data;
    } catch (error) {
      if (error && error.name === "AbortError") throw new Error("Mews request timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async getConfiguration() {
      const result = await post("/api/connector/v1/configuration/get");
      return {
        enterprise: result.Enterprise ? {
          id: result.Enterprise.Id || null,
          name: result.Enterprise.Name || null,
          timeZoneIdentifier: result.Enterprise.TimeZoneIdentifier || null
        } : null,
        nowUtc: result.NowUtc || null
      };
    },

    async getServices({ enterpriseIds, serviceIds, cursor, count = 100 } = {}) {
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("count must be between 1 and 100.");
      const fields = { Limitation: { Count: count } };
      if (Array.isArray(enterpriseIds) && enterpriseIds.length) fields.EnterpriseIds = enterpriseIds.map((v) => nonEmpty(v, "enterpriseId"));
      if (Array.isArray(serviceIds) && serviceIds.length) fields.ServiceIds = serviceIds.map((v) => nonEmpty(v, "serviceId"));
      if (cursor != null) fields.Limitation.Cursor = nonEmpty(cursor, "cursor");
      const result = await post("/api/connector/v1/services/getAll", fields);
      return {
        services: (result.Services || []).map((service) => ({
          id: service.Id,
          enterpriseId: service.EnterpriseId,
          active: Boolean(service.IsActive),
          names: service.Names || null,
          data: service.Data || null,
          externalIdentifier: service.ExternalIdentifier || null
        })),
        cursor: result.Cursor || null
      };
    },

    async getServiceAvailability({ serviceId, firstTimeUnitStartUtc, lastTimeUnitStartUtc, metrics = DEFAULT_METRICS } = {}) {
      const start = validUtc(firstTimeUnitStartUtc, "firstTimeUnitStartUtc");
      const end = validUtc(lastTimeUnitStartUtc, "lastTimeUnitStartUtc");
      if (Date.parse(end) < Date.parse(start)) throw new Error("lastTimeUnitStartUtc must not be before firstTimeUnitStartUtc.");
      if (!Array.isArray(metrics) || !metrics.length || metrics.length > 11 ||
          metrics.some((metric) => !DEFAULT_METRICS.concat(["OutOfOrderBlocks", "PublicAvailabilityAdjustment", "OtherServiceReservationCount", "BlockAvailability", "AllocatedBlockAvailability", "HouseUse"]).includes(metric))) {
        throw new Error("metrics contains an unsupported Mews availability metric.");
      }
      const result = await post("/api/connector/v1/services/getAvailability/2024-01-22", {
        ServiceId: nonEmpty(serviceId, "serviceId"),
        FirstTimeUnitStartUtc: start,
        LastTimeUnitStartUtc: end,
        Metrics: metrics
      });
      return {
        timeUnitStartsUtc: result.TimeUnitStartsUtc || [],
        resourceCategoryAvailabilities: (result.ResourceCategoryAvailabilities || []).map((entry) => ({
          resourceCategoryId: entry.ResourceCategoryId,
          metrics: entry.Metrics || {}
        }))
      };
    }
  });
}

module.exports = { DEMO_BASE_URL, createMewsConnectorClient };
