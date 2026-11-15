const {
  buildGuestSupportSystemPrompt,
  normalizeGuestSupportAnswer,
  resolveGuestSupportAnswer,
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
  });

  let parsedAnswer;
  try {
    parsedAnswer = JSON.parse(completion.choices?.[0]?.message?.content || "");
  } catch {
    parsedAnswer = null;
  }

  return resolveGuestSupportAnswer(
    message,
    normalizeGuestSupportAnswer(parsedAnswer),
  );
}

module.exports = { generateGuestSupportAnswer };
