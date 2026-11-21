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


test("guest-support engine accepts numeric details that are explicitly present in approved knowledge", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "Breakfast runs from 7:00 to 10:00. The transfer costs 1,500 THB.",
      needsHuman: false,
      handoffReason: "",
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Breakfast: 7:00–10:00. Airport transfer price: 1,500 THB.",
    message: "When is breakfast and what is the transfer price?",
  });

  assert.equal(result.needsHuman, false);
  assert.match(result.reply, /7:00 to 10:00/);
  assert.match(result.reply, /1,500 THB/);
});

test("guest-support engine hands off when the model invents opening times", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "Breakfast is served from 6:00 to 11:00.",
      needsHuman: false,
      handoffReason: "",
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Breakfast is served from 7:00 to 10:00.",
    message: "When is breakfast?",
  });

  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /cannot verify those details/i);
  assert.match(result.handoffReason, /numeric or currency details not present/i);
});

test("guest-support engine hands off when the model invents a price or changes its currency", async () => {
  const inventedPrice = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "The airport transfer costs 2,500 THB.",
      needsHuman: false,
      handoffReason: "",
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Airport transfers can be arranged through reception. The price must be confirmed by staff.",
    message: "How much is the airport transfer?",
  });
  assert.equal(inventedPrice.needsHuman, true);

  const wrongCurrency = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "The transfer costs $1,500.",
      needsHuman: false,
      handoffReason: "",
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Airport transfer price: 1,500 THB.",
    message: "What is the airport transfer price?",
  });
  assert.equal(wrongCurrency.needsHuman, true);
});

test("numeric grounding guard does not override an explicit model-requested staff handoff", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "I cannot verify the price. Please contact the front desk.",
      needsHuman: true,
      handoffReason: "Price confirmation required.",
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Airport transfer details are confirmed by staff.",
    message: "What is the airport transfer price?",
  });

  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /cannot verify the price/i);
  assert.match(result.handoffReason, /Price confirmation required/);
});
