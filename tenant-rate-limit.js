const { ipKeyGenerator } = require("express-rate-limit");

function tenantChatRateLimitKey(req) {
  const path = typeof req.path === "string" ? req.path : "";
  const match = path.match(/^\/([a-z0-9-]{1,48})\/chat(?:\/|$)/i);
  const tenant = match ? match[1].toLowerCase() : "unknown";
  const ip = typeof req.ip === "string" && req.ip ? req.ip : "127.0.0.1";
  return tenant + ":" + ipKeyGenerator(ip);
}

module.exports = { tenantChatRateLimitKey };
