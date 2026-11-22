const {
  buildGuestSupportSystemPrompt,
  normalizeGuestSupportAnswer,
  resolveGuestSupportAnswer,
  hasUnsupportedNumericClaims,
} = require("./guest-support-policy");

const GENERIC_REPLY_WORDS = new Set([
  "the", "and", "for", "from", "with", "that", "this", "when", "what", "where",
  "your", "you", "our", "their", "there", "are", "was", "were", "has", "have",
  "had", "can", "could", "would", "should", "will", "may", "might", "not", "but",
  "please", "thank", "thanks", "yes", "no", "hotel", "guest", "guests", "here",
  "there", "throughout", "welcomes", "welcome", "kindly", "also",
  "just", "only", "more", "most", "some", "any", "all", "each", "every",
  "runs", "run", "costs", "cost", "served",
]);

const APPROVED_TERM_ALIASES = new Map([
  ["complimentary", "free"],
  ["wireless", "wifi"],
  ["across", "throughout"],
  ["property", "hotel"],
]);

function getDescriptiveTerms(value) {
  return (String(value || "").toLowerCase().replace(/\bwireless\s+internet\b/g, "wifi").replace(/\bwi[\s-]?fi\b/g, "wifi").match(/[a-z]{3,}/g) || [])
    .map((term) => APPROVED_TERM_ALIASES.get(term) || term)
    .filter((term) => !GENERIC_REPLY_WORDS.has(term) && term !== "use");
}
function splitIntoClaimClauses(value) {
  return String(value || "")
    .split(/(?:[.!?;]+|\n+|\s+\b(?:and|but|while|whereas)\b\s+)/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function hasNegation(value) {
  return /\b(?:not|never|no|without|neither|cannot|can't|isn't|aren't|doesn't|don't|won't)\b/i.test(String(value || ""));
}

function hasRestrictiveQualification(value) {
  return /\b(?:only|except|unless|excluding|excluded|subject\s+to|provided\s+that|as\s+long\s+as)\b/i.test(String(value || ""));
}

function hasUnverifiedCompletionClaims(reply) {
  // The prototype has no action-confirmation channel for these operations.
  // A sentence explicitly saying it cannot verify completion is not a claim
  // that the action occurred.
  const completionClaim = /\b(?:i(?:'ve| have)\s+(?:booked|reserved|cancelled|canceled|refunded|processed|notified|alerted)|we(?:'ve| have)\s+(?:booked|reserved|cancelled|canceled|refunded|processed|notified|alerted)|(?:your|the)\s+(?:booking|reservation)\s+(?:is|has been)\s+(?:confirmed|booked|cancelled|canceled)|(?:staff|the hotel team)\s+(?:has|have)\s+been\s+(?:notified|alerted)|refund\s+(?:has|have)\s+been\s+processed)\b/i;
  return String(reply || "").split(/[.!?;]+|\n+/).some((sentence) =>
    completionClaim.test(sentence) &&
    !/\b(?:cannot|can't|unable to)\s+(?:confirm|verify)\b/i.test(sentence)
  );
}

function hasUnsupportedContentTerms(reply, approvedKnowledge) {
  const evidence = String(approvedKnowledge || "");
  const evidenceTerms = new Set(getDescriptiveTerms(evidence));
  const replyTerms = getDescriptiveTerms(reply);

  // First reject descriptive words that do not appear anywhere in approved context.
  if (replyTerms.some((term) => !evidenceTerms.has(term))) return true;

  // Match descriptive terms and negation polarity within the same evidence sentence.
  const evidenceSentences = evidence
    .split(/[.!?;]+|\n+/)
    .map((sentence) => ({
      terms: new Set(getDescriptiveTerms(sentence)),
      negated: hasNegation(sentence),
      qualified: hasRestrictiveQualification(sentence),
    }))
    .filter((sentence) => sentence.terms.size > 0);

  for (const clause of splitIntoClaimClauses(reply)) {
    const terms = getDescriptiveTerms(clause);
    if (!terms.length) continue;
    const clauseNegated = hasNegation(clause);
    const clauseQualified = hasRestrictiveQualification(clause);
    const supportedTogether = evidenceSentences.some((sentence) =>
      terms.every((term) => sentence.terms.has(term)) &&
      sentence.negated === clauseNegated &&
      sentence.qualified === clauseQualified
    );
    if (!supportedTogether) return true;
  }
  return false;
}

async function generateGuestSupportAnswer({
  ai,
  model,
  hotelName,
  approvedKnowledge,
  numericEvidence = approvedKnowledge,
  history = [],
  message,
}) {
  if (!ai || !ai.chat?.completions?.create) {
    throw new Error("AI provider is not configured.");
  }
  if (typeof message !== "string" || !message.trim()) {
    throw new TypeError("A guest message is required.");
  }

  const safeHistory = Array.isArray(history)
    ? history
        .filter((item) =>
          item &&
          (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string"
        )
        .slice(-8)
        .map((item) => ({
          role: item.role,
          content: item.content.slice(0, 1500),
        }))
    : [];

  const completion = await ai.chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: buildGuestSupportSystemPrompt(hotelName, approvedKnowledge),
      },
      ...safeHistory,
      { role: "user", content: message.trim() },
    ],
  }, { timeout: 15000, maxRetries: 0 });

  let parsedAnswer;
  try {
    parsedAnswer = JSON.parse(completion.choices?.[0]?.message?.content || "");
  } catch {
    parsedAnswer = null;
  }

  const normalizedAnswer = normalizeGuestSupportAnswer(parsedAnswer);
  if (
    !normalizedAnswer.needsHuman &&
    hasUnverifiedCompletionClaims(normalizedAnswer.reply)
  ) {
    return resolveGuestSupportAnswer(message, {
      reply: "I cannot confirm that this action has been completed. Please contact the front desk so the team can verify and assist.",
      needsHuman: true,
      handoffReason: "The AI response claimed a booking, cancellation, refund, or staff notification without a confirmed action result.",
    });
  }

  if (
    !normalizedAnswer.needsHuman &&
    hasUnsupportedNumericClaims(normalizedAnswer.reply, numericEvidence)
  ) {
    return resolveGuestSupportAnswer(message, {
      reply: "I cannot verify those details from the hotel's approved information. Please contact the front desk so the team can confirm them.",
      needsHuman: true,
      handoffReason: "The AI response included numeric or currency details not present in approved hotel information.",
    });
  }


  if (
    !normalizedAnswer.needsHuman &&
    hasUnsupportedContentTerms(normalizedAnswer.reply, approvedKnowledge)
  ) {
    return resolveGuestSupportAnswer(message, {
      reply: "I cannot verify every detail of that answer from the hotel's approved information. Please contact the front desk so the team can confirm it.",
      needsHuman: true,
      handoffReason: "The AI response included descriptive terms not present in the approved hotel information; lexical grounding requires staff review.",
    });
  }

  return resolveGuestSupportAnswer(message, normalizedAnswer);
}

function createNoKnowledgeAnswer(message) {
  return resolveGuestSupportAnswer(message, {
    reply: "I cannot verify that information from the hotel's approved guidance. Please contact the front desk so the team can assist you.",
    needsHuman: true,
    handoffReason: "No approved hotel information matched the guest question.",
  });
}

function createAiUnavailableAnswer() {
  return {
    reply: "I am unable to verify a response right now. Please contact the front desk directly so the team can assist you.",
    needsHuman: true,
    handoffReason: "AI provider unavailable or timed out; staff response required.",
  };
}

module.exports = { generateGuestSupportAnswer, createAiUnavailableAnswer, createNoKnowledgeAnswer, hasUnsupportedContentTerms, hasUnverifiedCompletionClaims };
