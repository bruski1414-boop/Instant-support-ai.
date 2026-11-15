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

const NON_CLAIM_TERMS = new Set([
  "a","about","after","again","all","also","am","an","and","any","are","as","ask","at","be","because",
  "been","before","being","best","between","both","but","by","can","cannot","could","day","days","dear",
  "did","do","does","during","each","either","else","enjoy","even","every","few","find","first","for",
  "from","get","give","glad","good","great","had","has","have","hello","help","here","how","i","if","in",
  "into","is","it","its","just","know","let","like","many","may","me","might","more","most","much","must",
  "near","need","neither","now","of","off","on","once","one","only","or","other","our","out",
  "please","provide","regarding","requested","requests","dates","date","january","february","march","april","may","june","july","august","september","october","november","december","same","see","shall","should","since","so","some","such","than","thank",
  "thanks","that","the","their","them","then","there","these","they","this","those","through","to","today",
  "tomorrow","too","under","up","us","very","was","we","well","were","what","when","where","which","while",
  "who","why","will","with","would","yes","you","your","hotel","team","staff","contact","assist","assistance",
  "email","visit","happy","sorry","apologize","apologies","welcome","pleasure","understand","understood","reach","check","checking","checked","confirm","confirmed","confirmation","information","question","questions","answer","details","available","availability","served","serving",
  "offer","offers","offered","offering","please","kindly","currently","simply","certainly","sure"
]);

function claimTerms(value) {
  return [...new Set((String(value || "").toLowerCase().match(/[a-z]{3,}/g) || [])
    .filter(term => !NON_CLAIM_TERMS.has(term)))];
}

function validateAnswerGrounding(reply, approvedContext, guestQuestion = "") {
  if (typeof reply !== "string" || !reply.trim()) {
    return { supported: false, reason: "empty_reply", unsupportedNumbers: [] };
  }
  if (typeof approvedContext !== "string" || !approvedContext.trim()) {
    return { supported: false, reason: "no_approved_context", unsupportedNumbers: numericFacts(reply) };
  }

  // Guest-provided text is never evidence for a hotel claim. It may supply
  // dates or quantities to repeat, but factual hotel details must exist in
  // approved hotel content. This deliberately prefers a safe handoff over
  // accepting a plausible but unsupported amenity or policy claim.
  const allowedNumbers = new Set([
    ...numericFacts(approvedContext),
    ...numericFacts(guestQuestion)
  ]);
  const unsupportedNumbers = [...new Set(numericFacts(reply).filter(number => !allowedNumbers.has(number)))];
  const allowedContacts = new Set([...contactFacts(approvedContext), ...contactFacts(guestQuestion)]);
  const unsupportedContacts = contactFacts(reply).filter(contact => !allowedContacts.has(contact));
  const allowedClaimTerms = new Set(claimTerms(approvedContext));
  const unsupportedClaimTerms = claimTerms(reply).filter(term => !allowedClaimTerms.has(term));

  if (unsupportedNumbers.length || unsupportedContacts.length || unsupportedClaimTerms.length) {
    const reason = unsupportedNumbers.length ? "unsupported_numeric_claim"
      : unsupportedContacts.length ? "unsupported_contact_detail" : "unsupported_claim_terms";
    return {
      supported: false,
      reason,
      unsupportedNumbers,
      ...(unsupportedContacts.length ? { unsupportedContacts } : {}),
      ...(unsupportedClaimTerms.length ? { unsupportedClaimTerms } : {})
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
