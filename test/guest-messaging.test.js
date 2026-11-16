const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeGuestConversationAccess,
  normalizeStaffReply,
  canReplyToConversation,
  isGuestConversationTokenActive,
  GUEST_TOKEN_TTL_DAYS
} = require("../guest-messaging");

test("validates guest conversation access without exposing or transforming the token", () => {
  const access = normalizeGuestConversationAccess(
    "123e4567-e89b-42d3-a456-426614174000",
    "a".repeat(43)
  );
  assert.equal(access.conversationId, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(access.token, "a".repeat(43));
});

test("rejects malformed conversation IDs and access tokens", () => {
  assert.throws(() => normalizeGuestConversationAccess("not-a-uuid", "a".repeat(43)));
  assert.throws(() => normalizeGuestConversationAccess("123e4567-e89b-42d3-a456-426614174000", "short"));
  assert.throws(() => normalizeGuestConversationAccess("123e4567-e89b-42d3-a456-426614174000", "a".repeat(43) + "!"));
});

test("normalizes staff replies and enforces message length", () => {
  assert.equal(normalizeStaffReply("  We can help with that.  "), "We can help with that.");
  assert.throws(() => normalizeStaffReply("   "));
  assert.throws(() => normalizeStaffReply("x".repeat(4001)));
  assert.throws(() => normalizeStaffReply({ message: "hello" }));
});

test("resolved conversations cannot receive a staff reply", () => {
  assert.equal(canReplyToConversation("open"), true);
  assert.equal(canReplyToConversation("escalated"), true);
  assert.equal(canReplyToConversation("resolved"), false);
});

test("guest conversation tokens expire after the configured 30-day lifetime", () => {
  const now = Date.parse("2026-11-16T00:00:00.000Z");
  assert.equal(GUEST_TOKEN_TTL_DAYS, 30);
  assert.equal(isGuestConversationTokenActive("2026-12-16T00:00:00.000Z", now), true);
  assert.equal(isGuestConversationTokenActive("2026-11-15T23:59:59.000Z", now), false);
  assert.equal(isGuestConversationTokenActive("not-a-date", now), false);
  assert.equal(isGuestConversationTokenActive(null, now), false);
});
