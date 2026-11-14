"use strict";

function numericFacts(value) {
  return (String(value || "").toLowerCase().match(/\b\d+(?:[.,]\d+)?\b/g) || [])
    .map(value => value.replace(",", "."));
}

function validateAnswerGrounding(reply, approvedContext, guestQuestion = "") {
  if (typeof reply !== "string" || !reply.trim()) {
    return { supported: false, reason: "empty_reply", unsupportedNumbers: [] };
  }
  if (typeof approvedContext !== "string" || !approvedContext.trim()) {
    return { supported: false, reason: "no_approved_context", unsupportedNumbers: numericFacts(reply) };
  }

  // Numbers may be repeated from the guest's own question (for example,
  // requested dates). New numeric claims must appear in approved hotel text.
  const allowedNumbers = new Set([
    ...numericFacts(approvedContext),
    ...numericFacts(guestQuestion)
  ]);
  const unsupportedNumbers = [...new Set(numericFacts(reply).filter(number => !allowedNumbers.has(number)))];

  if (unsupportedNumbers.length) {
    return {
      supported: false,
      reason: "unsupported_numeric_claim",
      unsupportedNumbers
    };
  }
  return { supported: true, reason: "", unsupportedNumbers: [] };
}

module.exports = { validateAnswerGrounding };
