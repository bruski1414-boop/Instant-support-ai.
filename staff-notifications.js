"use strict";

const crypto = require("node:crypto");
const { isIP } = require("node:net");

function encryptionKey(value) {
  if (!value || String(value).length < 32) throw new Error("STORAGE_TOKEN_ENCRYPTION_KEY must contain at least 32 characters.");
  return crypto.createHash("sha256").update(String(value)).digest();
}
function encryptSecret(secret, key) {
  if (typeof secret !== "string" || secret.length < 24 || secret.length > 512) throw new Error("Webhook signing secret must contain between 24 and 512 characters.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
function decryptSecret(value, key) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) throw new Error("Stored webhook secret is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(key), Buffer.from(parts[0], "base64url"));
  decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8");
}
function validateWebhookUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw new Error("Enter a valid HTTPS notification URL."); }
  const host = url.hostname.toLowerCase();
  const literalHost = host;
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      isIP(literalHost) !== 0 || host.startsWith("[") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".invalid") || host.endsWith(".example") ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
      host === "::1" || host.startsWith("[fc") || host.startsWith("[fd") || host.startsWith("[fe80")) {
    throw new Error("Use a public HTTPS webhook endpoint. Local, private-network and non-HTTPS destinations are not allowed.");
  }
  return url.toString();
}
async function deliverStaffEscalation({
  organization, conversationId, reason, idempotencyKey, webhookUrl, webhookSecret,
  event = "veyra.escalation.created", test = false, fetchImpl = fetch, timeoutMs = 5000
}) {
  if (!webhookUrl || !webhookSecret) return { configured: false, delivered: false, status: "not_configured" };
  const body = JSON.stringify({
    event, test: Boolean(test), organizationId: organization.id,
    organizationSlug: organization.slug, organization: organization.name,
    ...(conversationId ? { conversationId } : {}), ...(reason ? { reason } : {}),
    idempotencyKey: idempotencyKey || null, createdAt: new Date().toISOString()
  });
  const signature = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", "x-veyra-signature": signature,
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body, signal: controller.signal
    });
    return { configured: true, delivered: Boolean(response.ok), status: response.ok ? "delivered" : "failed" };
  } catch {
    return { configured: true, delivered: false, status: "failed" };
  } finally { clearTimeout(timer); }
}
function shouldRetryStaffNotification({ needsHuman, createdEscalation, notificationStatus, notificationAttempts }) {
  return Boolean(needsHuman && !createdEscalation && notificationStatus !== "delivered" &&
    Number.isInteger(Number(notificationAttempts)) && Number(notificationAttempts) >= 0 && Number(notificationAttempts) < 3);
}
module.exports = { deliverStaffEscalation, shouldRetryStaffNotification, encryptSecret, decryptSecret, validateWebhookUrl };
