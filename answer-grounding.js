"use strict";

function numericFacts(value) {
  return (String(value || "").toLowerCase().match(/\b\d+(?:[.,]\d+)?\b/g) || [])
    .map(value => value.replace(",", "."));
}

function contactFacts(value) {
  const text = String(value || "").toLowerCase();
  const emails = text.match(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/g) || [];
  const urls = text.match(/\b(?:https?:\/\/|www\.)[^\s<>"']+/g) || [];
  return [...new Set([...emails, ...urls].map(item => item.replace(/[),.;!?]+$/, "")))];
}

function validateAnswerGrounding(reply, approvedContext, guestQuestion = "") {
  if (typeof reply !== "string" || !reply.trim()) {
    return { supported: false, reason: "empty_reply", unsupportedNumbers: [] };
  }
  if (typeof approvedContext !== "string" || !approvedContext.trim()) {
    return { supported: false, reason: "no_approved_context", unsupportedNumbers: numericFacts(reply) };
  }

  // Numbers and contact details may be repeated from the guest's own question.
  // New numeric claims, emails and URLs must appear in approved hotel text.
  const allowedNumbers = new Set([
    ...numericFacts(approvedContext),
    ...numericFacts(guestQuestion)
  ]);
  const unsupportedNumbers = [...new Set(numericFacts(reply).filter(number => !allowedNumbers.has(number)))];
  const allowedContacts = new Set([...contactFacts(approvedContext), ...contactFacts(guestQuestion)]);
  const unsupportedContacts = contactFacts(reply).filter(contact => !allowedContacts.has(contact));

  if (unsupportedNumbers.length || unsupportedContacts.length) {
    return {
      supported: false,
      reason: unsupportedNumbers.length ? "unsupported_numeric_claim" : "unsupported_contact_detail",
      unsupportedNumbers,
      ...(unsupportedContacts.length ? { unsupportedContacts } : {})
    };
  }
  return { supported: true, reason: "", unsupportedNumbers: [] };
}

function validateStructuredAnswer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "response_not_an_object" };
  }
  const expectedKeys = ["handoffReason", "needsHuman", "reply"];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    return { valid: false, reason: "unexpected_response_fields" };
  }
  if (typeof value.reply !== "string" || !value.reply.trim() || value.reply.length > 4000) {
    return { valid: false, reason: "invalid_reply" };
  }
  if (typeof value.needsHuman !== "boolean") {
    return { valid: false, reason: "invalid_handoff_flag" };
  }
  if (typeof value.handoffReason !== "string" || value.handoffReason.length > 300) {
    return { valid: false, reason: "invalid_handoff_reason" };
  }
  if (value.needsHuman && !value.handoffReason.trim()) {
    return { valid: false, reason: "missing_handoff_reason" };
  }
  if (!value.needsHuman && value.handoffReason.trim()) {
    return { valid: false, reason: "unexpected_handoff_reason" };
  }
  return { valid: true, reason: "" };
}

module.exports = { validateAnswerGrounding, validateStructuredAnswer };
