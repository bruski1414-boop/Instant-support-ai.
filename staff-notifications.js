"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const https = require("node:https");
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
function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  const [a,b,c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255) return false;
  return true;
}
function validateWebhookUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw new Error("Enter a valid HTTPS notification URL."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !host || host.endsWith(".") || isIP(host) !== 0 || host.includes("%") ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".invalid") ||
      host.endsWith(".example") || host.endsWith(".example.com") || host.endsWith(".example.net") ||
      host.endsWith(".example.org")) {
    throw new Error("Use a public HTTPS hostname. IP literals, reserved domains and non-HTTPS destinations are not allowed.");
  }
  return url.toString();
}
async function resolvePublicAddress(hostname, lookup = dns.lookup, timeoutMs = 5000) {
  let timer;
  let records;
  try {
    records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Webhook DNS lookup timed out.")), timeoutMs); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
  if (!Array.isArray(records) || records.length === 0 ||
      records.some(record => !record || !isPublicIPv4(record.address))) {
    throw new Error("Webhook hostname must resolve exclusively to public IPv4 addresses.");
  }
  return records[0];
}
function postPinnedHttps(url, body, headers, address, requestImpl = https.request, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = requestImpl({
      protocol: "https:", hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method: "POST", headers,
      servername: url.hostname, rejectUnauthorized: true,
      lookup: (_hostname, _options, callback) => callback(null, address.address, 4)
    }, response => {
      response.resume();
      resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Webhook request timed out.")));
    req.on("error", reject);
    req.end(body);
  });
}
async function deliverStaffEscalation({
  organization, conversationId, reason, idempotencyKey, webhookUrl, webhookSecret,
  event = "veyra.escalation.created", test = false, timeoutMs = 5000,
  lookupImpl = dns.lookup, requestImpl = https.request
}) {
  if (!webhookUrl || !webhookSecret) return { configured: false, delivered: false, status: "not_configured" };
  try {
    const safeUrl = validateWebhookUrl(webhookUrl);
    const url = new URL(safeUrl);
    const address = await resolvePublicAddress(url.hostname, lookupImpl, timeoutMs);
    const body = JSON.stringify({
      event, test: Boolean(test), organizationId: organization.id,
      organizationSlug: organization.slug, organization: organization.name,
      ...(conversationId ? { conversationId } : {}), ...(reason ? { reason } : {}),
      idempotencyKey: idempotencyKey || null, createdAt: new Date().toISOString()
    });
    const signature = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
    const response = await postPinnedHttps(url, body, {
      "content-type": "application/json", "content-length": Buffer.byteLength(body),
      "x-veyra-signature": signature,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
    }, address, requestImpl, timeoutMs);
    return { configured: true, delivered: Boolean(response.ok), status: response.ok ? "delivered" : "failed" };
  } catch {
    return { configured: true, delivered: false, status: "failed" };
  }
}
function shouldRetryStaffNotification({ needsHuman, createdEscalation, notificationStatus, notificationAttempts }) {
  return Boolean(needsHuman && !createdEscalation && notificationStatus !== "delivered" &&
    Number.isInteger(Number(notificationAttempts)) && Number(notificationAttempts) >= 0 && Number(notificationAttempts) < 3);
}
module.exports = { deliverStaffEscalation, shouldRetryStaffNotification, encryptSecret, decryptSecret,
  validateWebhookUrl, isPublicIPv4, resolvePublicAddress, postPinnedHttps };
