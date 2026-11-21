const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateGuestSupportAnswer, createNoKnowledgeAnswer } = require("../guest-support-engine");

function fakeAi(content, inspect) {
  return {
    chat: {
      completions: {
        async create(request, options) {
          if (inspect) inspect(request, options);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

test("guest-support engine answers from the approved-knowledge prompt and keeps bounded conversation history", async () => {
  let request;
  let requestOptions;
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "Breakfast is served from 7:00 to 10:00.",
      needsHuman: false,
      handoffReason: "",
    }), (value, options) => { request = value; requestOptions = options; }),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "[facilities] Breakfast: 7:00–10:00",
    history: [
      { role: "user", content: "Previous question" },
      { role: "assistant", content: "Previous answer" },
      { role: "system", content: "This untrusted role must be removed" },
      { role: "user", content: "x".repeat(2000) },
    ],
    message: "When is breakfast?",
  });

  assert.equal(result.reply, "Breakfast is served from 7:00 to 10:00.");
  assert.equal(result.needsHuman, false);
  assert.equal(request.model, "test-model");
  assert.equal(request.temperature, 0.1);
  assert.deepEqual(requestOptions, { timeout: 15000, maxRetries: 0 });
  assert.equal(request.messages[0].role, "system");
  assert.match(request.messages[0].content, /approved hotel reference data only/);
  assert.equal(request.messages.at(-1).content, "When is breakfast?");
  assert.equal(request.messages.filter((item) => item.role === "system").length, 1);
  assert.equal(request.messages.at(-2).content.length, 1500);
});

test("guest-support engine overrides a model answer when a deterministic handoff is required", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "Breakfast starts at 7:00.",
      needsHuman: false,
      handoffReason: "",
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Breakfast is served at 7:00.",
    message: "There is smoke in the hallway.",
  });

  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /local emergency services now/);
  assert.match(result.reply, /Do not wait for a chat reply/);
});

test("guest-support engine fails closed when the model returns malformed JSON", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi("not-json"),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Breakfast is served at 7:00.",
    message: "When is breakfast?",
  });

  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /cannot prepare a reliable answer/);
});

test("guest-support engine rejects missing AI configuration and empty messages", async () => {
  await assert.rejects(
    () => generateGuestSupportAnswer({ ai: null, message: "Hello" }),
    /AI provider is not configured/,
  );
  await assert.rejects(
    () => generateGuestSupportAnswer({ ai: fakeAi("{}"), message: "  " }),
    /guest message is required/,
  );
});


test("AI outage fallback gives a clear front-desk instruction and always requests staff help", () => {
  const { createAiUnavailableAnswer } = require("../guest-support-engine");
  const result = createAiUnavailableAnswer();

  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /unable to verify a response right now/i);
  assert.match(result.reply, /contact the front desk directly/i);
  assert.match(result.handoffReason, /provider unavailable or timed out/i);
});

test("no matching approved knowledge deterministically requires staff review", () => {
  const result = createNoKnowledgeAnswer("What is the price of a helicopter transfer?");
  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /cannot verify that information/i);
  assert.match(result.reply, /contact the front desk/i);
  assert.match(result.handoffReason, /No approved hotel information matched/);
});

test("no-knowledge fallback still preserves immediate-danger safety handling", () => {
  const result = createNoKnowledgeAnswer("There is smoke in the hallway.");
  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /local emergency services now/);
  assert.match(result.reply, /Do not wait for a chat reply/);
});
