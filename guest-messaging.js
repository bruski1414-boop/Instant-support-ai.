const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{40,64}$/;

function normalizeGuestConversationAccess(conversationId, token) {
  if (typeof conversationId !== "string" || !UUID.test(conversationId)) {
    throw new Error("A valid conversation reference is required.");
  }
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw new Error("A valid conversation access token is required.");
  }
  return Object.freeze({ conversationId, token });
}

function normalizeStaffReply(input) {
  if (typeof input !== "string") throw new Error("Enter a staff reply.");
  const message = input.trim();
  if (!message || message.length > 4000) throw new Error("Staff replies must contain 1–4,000 characters.");
  return message;
}

function canReplyToConversation(status) {
  return status !== "resolved";
}

module.exports = { normalizeGuestConversationAccess, normalizeStaffReply, canReplyToConversation };
