"use strict";

const { createTokenCipher } = require("./storage-security");

function createStaffWebhookStore({ db, encryptionKey, allowedHosts = "", allowInsecureLoopback = false } = {}) {
  if (!db || typeof db.query !== "function") throw new Error("A database client is required.");
  const cipher = createTokenCipher(encryptionKey || "");
  const hosts = new Set(String(allowedHosts).split(",").map(x => x.trim().toLowerCase()).filter(Boolean));

  function validate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Staff webhook settings are required.");
    const webhookUrl = typeof input.webhookUrl === "string" ? input.webhookUrl.trim() : "";
    const webhookSecret = typeof input.webhookSecret === "string" ? input.webhookSecret.trim() : "";
    let url;
    try { url = new URL(webhookUrl); } catch { throw new Error("Enter a valid webhook URL."); }
    const host = url.hostname.toLowerCase();
    const loopback = allowInsecureLoopback && (host === "127.0.0.1" || host === "localhost" || host === "::1");
    if ((!loopback && url.protocol !== "https:") || (loopback && !["http:", "https:"].includes(url.protocol)) ||
        url.username || url.password || (url.port && !((url.protocol === "https:" && url.port === "443") || (loopback && url.port)))) {
      throw new Error("Webhook URLs must use HTTPS, without embedded credentials or non-standard ports.");
    }
    const allowed = loopback || Array.from(hosts).some(domain => host === domain || host.endsWith("." + domain));
    if (!allowed) throw new Error("This webhook host is not on the operator-approved allowlist. Ask the Veyra operator to approve the domain first.");
    if (!webhookSecret || webhookSecret.length < 24 || webhookSecret.length > 4096) throw new Error("Webhook signing secrets must contain between 24 and 4096 characters.");
    return { webhookUrl: url.toString(), webhookSecret };
  }

  async function save({ organizationId, userId, input }) {
    if (!cipher.configured) throw new Error("STAFF_WEBHOOK_ENCRYPTION_KEY is not configured on the server.");
    const values = validate(input);
    const encrypted = cipher.encrypt({ webhookSecret: values.webhookSecret });
    const result = await db.query(
      "INSERT INTO organization_staff_webhooks(organization_id,webhook_url,encrypted_secret,status,configured_by,configured_at,verified_at,last_error,updated_at) VALUES($1,$2,$3,'configured',$4,now(),NULL,NULL,now()) ON CONFLICT(organization_id) DO UPDATE SET webhook_url=EXCLUDED.webhook_url,encrypted_secret=EXCLUDED.encrypted_secret,status='configured',configured_by=EXCLUDED.configured_by,configured_at=now(),verified_at=NULL,last_error=NULL,updated_at=now() RETURNING organization_id,webhook_url,status,configured_at,verified_at,last_error",
      [organizationId, values.webhookUrl, encrypted, userId]
    );
    return publicStatus(result.rows[0]);
  }

  function publicStatus(row) {
    if (!row) return { configured: false, verified: false, status: "not_configured" };
    let hostname = "";
    try { hostname = new URL(row.webhook_url).hostname; } catch {}
    return {
      configured: true,
      verified: row.status === "verified",
      status: row.status,
      hostname,
      configuredAt: row.configured_at || null,
      verifiedAt: row.verified_at || null,
      lastError: row.last_error || null
    };
  }

  async function getStatus(organizationId) {
    const result = await db.query(
      "SELECT webhook_url,status,configured_at,verified_at,last_error FROM organization_staff_webhooks WHERE organization_id=$1",
      [organizationId]
    );
    return publicStatus(result.rows[0]);
  }

  async function resolve(organizationId) {
    if (!cipher.configured) return null;
    const result = await db.query(
      "SELECT webhook_url,encrypted_secret,status FROM organization_staff_webhooks WHERE organization_id=$1 AND status IN ('configured','verified')",
      [organizationId]
    );
    if (!result.rowCount) return null;
    const credentials = cipher.decrypt(result.rows[0].encrypted_secret);
    return { webhookUrl: result.rows[0].webhook_url, webhookSecret: credentials.webhookSecret, verified: result.rows[0].status === "verified" };
  }

  async function markVerified(organizationId) {
    await db.query("UPDATE organization_staff_webhooks SET status='verified',verified_at=now(),last_error=NULL,updated_at=now() WHERE organization_id=$1", [organizationId]);
    return getStatus(organizationId);
  }

  async function markError(organizationId, message) {
    await db.query("UPDATE organization_staff_webhooks SET status='error',last_error=$1,updated_at=now() WHERE organization_id=$2", [String(message || "Verification failed").slice(0, 240), organizationId]);
  }

  async function remove(organizationId) {
    await db.query("DELETE FROM organization_staff_webhooks WHERE organization_id=$1", [organizationId]);
  }

  return Object.freeze({ save, getStatus, resolve, markVerified, markError, remove, encryptionConfigured: cipher.configured, allowedHostsConfigured: hosts.size > 0 });
}

module.exports = { createStaffWebhookStore };
