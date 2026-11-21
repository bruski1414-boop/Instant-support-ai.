const {
  buildGuestSupportSystemPrompt,
  normalizeGuestSupportAnswer,
  resolveGuestSupportAnswer,
  hasUnsupportedNumericClaims,
} = require("./guest-support-policy");

async function generateGuestSupportAnswer({
  ai,
  model,
  hotelName,
  approvedKnowledge,
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
    hasUnsupportedNumericClaims(normalizedAnswer.reply, numericEvidence)
  ) {
    return resolveGuestSupportAnswer(message, {
      reply: "I cannot verify those details from the hotel's approved information. Please contact the front desk so the team can confirm them.",
      needsHuman: true,
      handoffReason: "The AI response included numeric or currency details not present in approved hotel information.",
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

module.exports = { generateGuestSupportAnswer, createAiUnavailableAnswer, createNoKnowledgeAnswer };
