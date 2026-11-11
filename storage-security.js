const crypto = require("node:crypto");

function createTokenCipher(keyText) {
  let key = null;
  try {
    const decoded = Buffer.from(String(keyText || ""), "base64");
    if (decoded.length === 32) key = decoded;
  } catch {}

  function encrypt(value) {
    if (!key) throw new Error("STORAGE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  function decrypt(value) {
    if (!key) throw new Error("Storage encryption key is unavailable.");
    const parts = String(value).split(".");
    if (parts.length !== 3 || parts.some(part => !part)) throw new Error("Invalid encrypted token format.");
    const [iv, tag, body] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"));
  }

  return { encrypt, decrypt, configured: Boolean(key) };
}

async function readTextLimited(response, maxBytes = 12000) {
  if (!response || !response.ok || !response.body) throw new Error("Could not download the selected document.");
  const rawLength = response.headers && response.headers.get ? response.headers.get("content-length") : null;
  const declared = rawLength === null ? 0 : Number(rawLength);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("The selected file is larger than the 12 KB knowledge-document limit.");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("The selected file is larger than the 12 KB knowledge-document limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const MICROSOFT_DOWNLOAD_HOSTS = ["sharepoint.com", "sharepointonline.com", "1drv.com"];

function validateMicrosoftDownloadUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("Microsoft returned an invalid document download URL."); }
  const host = url.hostname.toLowerCase();
  const allowedHost = MICROSOFT_DOWNLOAD_HOSTS.some(domain => host === domain || host.endsWith("." + domain));
  if (url.protocol !== "https:" || !allowedHost || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("Microsoft returned a document URL outside the approved download hosts.");
  }
  return url.toString();
}

async function fetchMicrosoftDownload(value, options = {}) {
  let url = validateMicrosoftDownloadUrl(value);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(url, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === 3) throw new Error("Microsoft document download exceeded the redirect limit.");
    const location = response.headers.get("location");
    if (!location) throw new Error("Microsoft document download returned an invalid redirect.");
    await response.body?.cancel().catch(() => {});
    url = validateMicrosoftDownloadUrl(new URL(location, url).toString());
  }
  throw new Error("Microsoft document download failed.");
}

module.exports = { createTokenCipher, readTextLimited, validateMicrosoftDownloadUrl, fetchMicrosoftDownload };
