const { isIP } = require("node:net");

function normalizeClientIp(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const ip = raw.split("%")[0];
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return ip || "unknown";

  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    if (isIP(mapped) === 4) return mapped;
  }

  const halves = ip.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array(missing).fill("0"), ...right]
    .map((part) => parseInt(part || "0", 16).toString(16).padStart(4, "0"));
  return groups.slice(0, 4).join(":");
}

function tenantChatRateLimitKey(req) {
  const path = typeof req.path === "string" ? req.path : "";
  const match = path.match(/^\/api\/public\/([a-z0-9-]{1,48})\/chat(?:\/|$)/i);
  const tenant = match ? match[1].toLowerCase() : "unknown";
  const ip = normalizeClientIp(req.ip);
  return tenant + ":" + ip;
}

module.exports = { tenantChatRateLimitKey, normalizeClientIp };
