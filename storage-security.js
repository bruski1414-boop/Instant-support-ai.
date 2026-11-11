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

module.exports = { createTokenCipher, readTextLimited };
