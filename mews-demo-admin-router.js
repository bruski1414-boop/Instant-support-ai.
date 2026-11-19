"use strict";

const { createMewsConnectorClient } = require("./mews-connector-client");
const { createMewsAvailabilityAdapter } = require("./mews-availability-adapter");
const { createMewsTimeUnitResolver } = require("./mews-timezone-resolver");

const PROVIDER = "mews_demo";

function cleanText(value, field, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error(field + " is invalid.");
  }
  return value.trim();
}

function validateDemoConfig(input = {}) {
  const config = {
    clientToken: cleanText(input.clientToken, "clientToken", 512),
    accessToken: cleanText(input.accessToken, "accessToken", 512),
    clientName: cleanText(input.clientName, "clientName", 100),
    serviceId: cleanText(input.serviceId, "serviceId", 128),
    resourceCategoryId: cleanText(input.resourceCategoryId, "resourceCategoryId", 128),
    timeZone: cleanText(input.timeZone, "timeZone", 100)
  };
  createMewsTimeUnitResolver(config.timeZone);
  return config;
}

function createMewsDemoAdminRouter({
  express,
  db,
  auth,
  role,
  limiter,
  credentialVault,
  enabled = false,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!express || typeof express.Router !== "function" || !db || typeof db.query !== "function" ||
      typeof auth !== "function" || typeof role !== "function" || !credentialVault ||
      typeof credentialVault.encrypt !== "function" || typeof credentialVault.decrypt !== "function") {
    throw new Error("Mews demo admin router dependencies are incomplete.");
  }

  const router = express.Router();

  function featureGate(_req, res, next) {
    if (enabled !== true) return res.status(404).json({ error: "Mews demo integration is disabled on this server." });
    next();
  }

  async function loadConfig(organizationId) {
    const saved = await db.query(
      "SELECT encrypted_credentials FROM pms_connections WHERE organization_id=$1 AND provider=$2 AND mode='sandbox'",
      [organizationId, PROVIDER]
    );
    if (!saved.rowCount) return null;
    return validateDemoConfig(credentialVault.decrypt(saved.rows[0].encrypted_credentials));
  }

  function clientFor(organizationId, config) {
    return createMewsConnectorClient({
      environment: "demo",
      clientToken: config.clientToken,
      accessToken: config.accessToken,
      clientName: config.clientName,
      tenantId: organizationId,
      allowReservationWrites: false,
      fetchImpl
    });
  }

  router.get("/status", auth, role("owner", "admin"), featureGate, async (req, res) => {
    try {
      const result = await db.query(
        "SELECT status,connected_at,last_tested_at,(last_error <> '') AS has_error FROM pms_connections WHERE organization_id=$1 AND provider=$2 AND mode='sandbox'",
        [req.actor.organization_id, PROVIDER]
      );
      res.json({
        enabled: true,
        configured: result.rowCount === 1,
        status: result.rows[0]?.status || "not_configured",
        connectedAt: result.rows[0]?.connected_at || null,
        lastTestedAt: result.rows[0]?.last_tested_at || null,
        hasError: result.rows[0]?.has_error === true,
        mode: "demo_read_only",
        bookingWritesEnabled: false
      });
    } catch {
      res.status(500).json({ error: "Could not read the Mews demo connection status." });
    }
  });

  router.post("/connect", auth, role("owner", "admin"), ...(limiter ? [limiter] : []), featureGate, async (req, res) => {
    try {
      const config = validateDemoConfig(req.body || {});
      const encrypted = credentialVault.encrypt(config);
      await db.query(
        "INSERT INTO pms_connections(organization_id,provider,mode,status,encrypted_credentials,scopes,connected_by,connected_at,last_tested_at,last_error,updated_at) VALUES($1,$2,'sandbox','pending_authorization',$3,ARRAY['availability:read'],$4,NULL,NULL,'',now()) ON CONFLICT(organization_id,provider) DO UPDATE SET mode='sandbox',status='pending_authorization',encrypted_credentials=EXCLUDED.encrypted_credentials,scopes=EXCLUDED.scopes,connected_by=EXCLUDED.connected_by,connected_at=NULL,last_tested_at=NULL,last_error='',updated_at=now()",
        [req.actor.organization_id, PROVIDER, encrypted, req.actor.user_id]
      );
      await db.query(
        "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'integration.mews_demo_configured','pms_connection',$3)",
        [req.actor.organization_id, req.actor.user_id, PROVIDER]
      );
      res.status(201).json({
        provider: PROVIDER, mode: "demo_read_only", status: "pending_authorization",
        credentialsStored: true, bookingWritesEnabled: false,
        notice: "Credentials are encrypted at rest. Run the read-only connection test before checking availability."
      });
    } catch {
      res.status(400).json({ error: "Mews demo settings are invalid or could not be stored securely. Check the approved demo configuration." });
    }
  });

  router.post("/test", auth, role("owner", "admin"), ...(limiter ? [limiter] : []), featureGate, async (req, res) => {
    try {
      const config = await loadConfig(req.actor.organization_id);
      if (!config) return res.status(409).json({ verified: false, error: "Configure this hotel's Mews demo credentials first." });
      const client = clientFor(req.actor.organization_id, config);
      const result = await client.getConfiguration();
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        return res.status(502).json({ verified: false, error: "Mews demo returned an invalid configuration response." });
      }
      await db.query(
        "UPDATE pms_connections SET status='connected',connected_at=now(),last_tested_at=now(),last_error='',updated_at=now() WHERE organization_id=$1 AND provider=$2",
        [req.actor.organization_id, PROVIDER]
      );
      await db.query(
        "INSERT INTO organization_pms_adapter_tests(organization_id,provider,mode,test_passed,tested_by,tested_at) VALUES($1,$2,'sandbox',true,$3,now()) ON CONFLICT(organization_id,provider) DO UPDATE SET mode='sandbox',test_passed=true,tested_by=EXCLUDED.tested_by,tested_at=now()",
        [req.actor.organization_id, PROVIDER, req.actor.user_id]
      );
      await db.query(
        "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'integration.mews_demo_tested','pms_connection',$3)",
        [req.actor.organization_id, req.actor.user_id, PROVIDER]
      );
      res.json({ verified: true, provider: PROVIDER, mode: "demo_read_only", availabilityReadEnabled: true, bookingWritesEnabled: false,
        notice: "Mews demo credentials passed a read-only configuration request. Room availability and reservation writes have not been tested." });
    } catch {
      await db.query(
        "UPDATE pms_connections SET status='error',last_tested_at=now(),last_error='Connection test failed',updated_at=now() WHERE organization_id=$1 AND provider=$2",
        [req.actor.organization_id, PROVIDER]
      ).catch(() => {});
      res.status(502).json({ verified: false, error: "Mews demo connection could not be verified. Check the credentials with the hotel's authorised administrator." });
    }
  });

  router.post("/availability", auth, role("owner", "admin"), ...(limiter ? [limiter] : []), featureGate, async (req, res) => {
    try {
      const arrivalDate = cleanText(req.body?.arrivalDate, "arrivalDate", 10);
      const departureDate = cleanText(req.body?.departureDate, "departureDate", 10);
      const config = await loadConfig(req.actor.organization_id);
      if (!config) return res.status(409).json({ verified: false, error: "Configure and test this hotel's Mews demo connection first." });
      const client = clientFor(req.actor.organization_id, config);
      const adapter = createMewsAvailabilityAdapter({
        client, tenantId: req.actor.organization_id,
        serviceId: config.serviceId,
        resourceCategoryId: config.resourceCategoryId,
        resolveTimeUnits: createMewsTimeUnitResolver(config.timeZone)
      });
      const availability = await adapter.checkAvailability({
        arrivalDate, departureDate, roomTypeCode: config.resourceCategoryId
      });
      await db.query(
        "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id) VALUES($1,$2,'integration.mews_demo_availability_checked','pms_connection',$3)",
        [req.actor.organization_id, req.actor.user_id, PROVIDER]
      );
      res.json({
        verified: true, mode: "demo_read_only",
        arrivalDate: availability.arrivalDate, departureDate: availability.departureDate,
        roomTypeCode: availability.roomTypeCode, roomsAvailable: availability.roomsAvailable,
        observedAt: availability.observedAt, validUntil: availability.validUntil,
        source: availability.source, bookingWritesEnabled: false
      });
    } catch {
      res.status(502).json({ verified: false, error: "Mews demo availability could not be verified for those dates and the configured room category." });
    }
  });

  return router;
}

module.exports = { createMewsDemoAdminRouter, validateDemoConfig };
