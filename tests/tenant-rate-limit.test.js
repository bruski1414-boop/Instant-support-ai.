const test = require("node:test");
const assert = require("node:assert/strict");
const { tenantChatRateLimitKey, normalizeClientIp } = require("../tenant-rate-limit");

test("rate limit key separates hotels sharing the same client IP", () => {
  const ip = "203.0.113.10";
  const alpha = tenantChatRateLimitKey({ path: "/hotel-alpha/chat", ip });
  const beta = tenantChatRateLimitKey({ path: "/hotel-beta/chat", ip });
  assert.notEqual(alpha, beta);
});

test("same hotel and client IP share a rate limit key", () => {
  const first = tenantChatRateLimitKey({ path: "/hotel-alpha/chat", ip: "203.0.113.10" });
  const second = tenantChatRateLimitKey({ path: "/hotel-alpha/chat", ip: "203.0.113.10" });
  assert.equal(first, second);
});

test("IPv6 privacy addresses in the same /64 share a rate limit key", () => {
  const first = tenantChatRateLimitKey({ path: "/hotel-alpha/chat", ip: "2001:db8:abcd:12::1" });
  const second = tenantChatRateLimitKey({ path: "/hotel-alpha/chat", ip: "2001:db8:abcd:12::2" });
  assert.equal(first, second);
});

test("IPv4-mapped IPv6 addresses normalize to their IPv4 address", () => {
  assert.equal(normalizeClientIp("::ffff:203.0.113.10"), "203.0.113.10");
});

test("malformed paths use a safe fallback tenant bucket", () => {
  const key = tenantChatRateLimitKey({ path: "/not-a-chat-route", ip: "203.0.113.10" });
  assert.match(key, /^unknown:/);
});
