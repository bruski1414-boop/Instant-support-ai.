"use strict";

const { validateStructuredAnswer } = require("./answer-grounding");

const SAFE_FALLBACK = Object.freeze({
  reply: "I can’t prepare a reliable answer right now. I’ll ask the hotel team to help you.",
  needsHuman: true,
  handoffReason: "The AI answer service was unavailable or returned an invalid response."
});

async function generateStructuredGuestAnswer({ client, model, messages }) {
  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages
    });
    let answer;
    try {
      answer = JSON.parse(completion.choices[0]?.message?.content || "");
    } catch {
      return { ...SAFE_FALLBACK, handoffReason: "The AI provider returned invalid JSON." };
    }
    const validation = validateStructuredAnswer(answer);
    if (!validation.valid) {
      return { ...SAFE_FALLBACK, handoffReason: "The AI provider returned an invalid response format (" + validation.reason + ")." };
    }
    return answer;
  } catch {
    return SAFE_FALLBACK;
  }
}

module.exports = { generateStructuredGuestAnswer, SAFE_FALLBACK };
