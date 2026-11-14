"use strict";

const { createTokenCipher } = require("./storage-security");
const { createMewsConnectorClient } = require("./mews-connector");

function createMewsConnectionStore({ db, encryptionKey, clientName = "Veyra AI/0.1" } = {}) {
  if (!db || typeof db.query !== "function") throw new Error("A database client is required.");
  const cipher = createTokenCipher(encryptionKey || "");

  function validate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Mews connection details are required.");
    const clientToken = typeof input.clientToken === "string" ? input.clientToken.trim() : "";
    const accessToken = typeof input.accessToken === "string" ? input.accessToken.trim() : "";
    const serviceId = typeof input.serviceId === "string" ? input.serviceId.trim() : "";
    const propertyReference = typeof input.propertyReference === "string" ? input.propertyReference.trim() : "";
    const timeZone = typeof input.timeZone === "string" ? input.timeZone.trim() : "";
    if (!clientToken || clientToken.length > 2048 || !accessToken || accessToken.length > 2048) throw new Error("Mews credentials are missing or too long.");
    if (!serviceId || serviceId.length > 200 || !propertyReference || propertyReference.length > 200) throw new Error("Mews service and property references are required.");
    if (!timeZone || timeZone.length > 100) throw new Error("A valid property time zone is required.");
    try { new Intl.DateTimeFormat("en", { timeZone }).format(new Date()); } catch { throw new Error("Enter a valid IANA property time zone."); }
    return { clientToken, accessToken, serviceId, propertyReference, timeZone };
  }

  async function save({ organizationId, userId, input }) {
    const values = validate(input);
    if (!cipher.configured) throw new Error("Mews credential encryption is not configured on the server.");
    const encrypted = cipher.encrypt({ clientToken: values.clientToken, accessToken: values.accessToken });
    const result = await db.query(
      "INSERT INTO mews_connections(organization_id,encrypted_credentials,service_id,property_reference,timezone,status,connected_by,connected_at,updated_at) VALUES($1,$2,$3,$4,$5,'configured',$6,now(),now()) ON CONFLICT(organization_id) DO UPDATE SET encrypted_credentials=EXCLUDED.encrypted_credentials,service_id=EXCLUDED.service_id,property_reference=EXCLUDED.property_reference,timezone=EXCLUDED.timezone,status='configured',connected_by=EXCLUDED.connected_by,connected_at=now(),last_verified_at=NULL,last_error=NULL,updated_at=now() RETURNING organization_id,service_id,property_reference,timezone,status,connected_at,last_verified_at",
      [organizationId, encrypted, values.serviceId, values.propertyReference, values.timeZone, userId]
    );
    return result.rows[0];
  }

  async function getStatus(organizationId) {
    const result = await db.query(
      "SELECT service_id,property_reference,timezone,status,connected_at,last_verified_at,last_error FROM mews_connections WHERE organization_id=$1",
      [organizationId]
    );
    return result.rows[0] || null;
  }

  async function resolveConnection(organizationId, allowedStatuses) {
    const result = await db.query(
      "SELECT organization_id,encrypted_credentials,service_id,property_reference,timezone FROM mews_connections WHERE organization_id=$1 AND status = ANY($2::text[]) AND (status <> 'verified' OR last_verified_at > now() - interval '30 days')",
      [organizationId, allowedStatuses]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const credentials = cipher.decrypt(row.encrypted_credentials);
    return {
      organizationId: row.organization_id,
      client: createMewsConnectorClient({
        clientToken: credentials.clientToken,
        accessToken: credentials.accessToken,
        clientName
      }),
      service: { id: row.service_id, timeUnitPeriod: "Day" },
      propertyReference: row.property_reference,
      timeZone: row.timezone
    };
  }

  async function resolve(organizationId) {
    return resolveConnection(organizationId, ['verified']);
  }

  async function verify(organizationId) {
    const connection = await resolveConnection(organizationId, ['configured', 'error', 'verified']);
    if (!connection) throw new Error("No Mews connection is configured for this hotel.");
    const [configuration, services] = await Promise.all([
      connection.client.getConfiguration(),
      connection.client.getAllServices({ serviceIds: [connection.service.id], maxPages: 2, count: 100 })
    ]);
    if (!configuration.enterprise || configuration.enterprise.id !== connection.propertyReference) {
      throw new Error("The configured property reference does not match the authenticated Mews property.");
    }
    if (configuration.enterprise.timeZoneIdentifier !== connection.timeZone) {
      throw new Error("The configured time zone does not match the authenticated Mews property's time zone.");
    }
    const service = services.services.find((item) => item.id === connection.service.id && item.active);
    if (!service || service.timeUnitPeriod !== "Day") throw new Error("Choose an active daily accommodation service in Mews.");
    await db.query("UPDATE mews_connections SET status='verified',last_verified_at=now(),last_error=NULL,updated_at=now() WHERE organization_id=$1", [organizationId]);
    return { verified: true, propertyTimeZone: configuration.enterprise.timeZoneIdentifier, serviceTimeUnit: service.timeUnitPeriod };
  }

  async function remove(organizationId) {
    await db.query("DELETE FROM mews_connections WHERE organization_id=$1", [organizationId]);
  }

  return Object.freeze({ save, getStatus, resolve, verify, remove, encryptionConfigured: cipher.configured });
}

module.exports = { createMewsConnectionStore };
