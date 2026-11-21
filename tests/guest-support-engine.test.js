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


test("content grounding treats Wi-Fi spelling variants as the same approved term", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "The wifi network is available throughout the property.",
      needsHuman: false,
      handoffReason: "",
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "The Wi-Fi network is available throughout the property.",
    message: "Is Wi-Fi available?",
  });

  assert.equal(result.needsHuman, false);
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


test("guest-support engine hands off when a reply adds an unsupported non-numeric location detail", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "Breakfast is served on the beach.",
      needsHuman: false,
      handoffReason: "",
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Breakfast buffet is served daily from 7:00 to 10:00.",
    message: "When is breakfast?",
  });

  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /cannot verify every detail/i);
  assert.match(result.handoffReason, /descriptive terms not present/i);
});


test("content grounding does not combine separate sentences to invent a relationship", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "Breakfast is served on the beach.",
      needsHuman: false,
      handoffReason: "",
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Breakfast buffet is served daily from 7:00 to 10:00. The beach is open to guests.",
    message: "When is breakfast?",
  });

  assert.equal(result.needsHuman, true);
  assert.match(result.handoffReason, /lexical grounding requires staff review/i);
});

test("content grounding still accepts a descriptive claim supported together in one sentence", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "Breakfast buffet is served daily.",
      needsHuman: false,
      handoffReason: "",
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Breakfast buffet is served daily from 7:00 to 10:00.",
    message: "What is served for breakfast?",
  });

  assert.equal(result.needsHuman, false);
  assert.match(result.reply, /Breakfast buffet is served daily/i);
});


test("content grounding rejects a reply that reverses an approved negative claim", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({ reply: "Breakfast is served on the beach.", needsHuman: false, handoffReason: "" })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Breakfast is not served on the beach.",
    message: "Is breakfast served on the beach?",
  });
  assert.equal(result.needsHuman, true);
  assert.match(result.handoffReason, /lexical grounding requires staff review/i);
});

test("content grounding accepts a reply that preserves an approved negative claim", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({ reply: "Breakfast is not served on the beach.", needsHuman: false, handoffReason: "" })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "Breakfast is not served on the beach.",
    message: "Is breakfast served on the beach?",
  });
  assert.equal(result.needsHuman, false);
});


for (const scenario of [
  {
    name: "available to unavailable",
    evidence: "Pool access is available to hotel guests.",
    reply: "Pool access is unavailable to hotel guests.",
  },
  {
    name: "unavailable to available",
    evidence: "Pool access is unavailable to hotel guests.",
    reply: "Pool access is available to hotel guests.",
  },
  {
    name: "not included to included",
    evidence: "Breakfast is not included in the room rate.",
    reply: "Breakfast is included in the room rate.",
  },
  {
    name: "included to not included",
    evidence: "Breakfast is included in the room rate.",
    reply: "Breakfast is not included in the room rate.",
  },
  {
    name: "permitted to prohibited",
    evidence: "Bicycles are permitted in the garden.",
    reply: "Bicycles are prohibited in the garden.",
  },
  {
    name: "prohibited to permitted",
    evidence: "Bicycles are prohibited in the garden.",
    reply: "Bicycles are permitted in the garden.",
  },
]) {
  test(`content grounding rejects a contradiction: ${scenario.name}`, async () => {
    const result = await generateGuestSupportAnswer({
      ai: fakeAi(JSON.stringify({
        reply: scenario.reply,
        needsHuman: false,
        handoffReason: "",
      })),
      model: "test-model",
      hotelName: "Aster House",
      approvedKnowledge: scenario.evidence,
      message: "Can you confirm this hotel policy?",
    });

    assert.equal(result.needsHuman, true);
    assert.match(result.handoffReason, /lexical grounding requires staff review/i);
  });
}


for (const scenario of [
  {
    name: "omitted exception",
    evidence: "Pool access is available except during scheduled maintenance.",
    reply: "Pool access is available.",
  },
  {
    name: "omitted only restriction",
    evidence: "The spa is available only to registered hotel guests.",
    reply: "The spa is available to registered hotel guests.",
  },
  {
    name: "omitted conditional restriction",
    evidence: "Children may use the pool provided that an adult accompanies them.",
    reply: "Children may use the pool.",
  },
  {
    name: "preserved exception",
    evidence: "Pool access is available except during scheduled maintenance.",
    reply: "Pool access is available except during scheduled maintenance.",
  },
]) {
  test(`content grounding checks restrictive qualifications: ${scenario.name}`, async () => {
    const result = await generateGuestSupportAnswer({
      ai: fakeAi(JSON.stringify({
        reply: scenario.reply,
        needsHuman: false,
        handoffReason: "",
      })),
      model: "test-model",
      hotelName: "Aster House",
      approvedKnowledge: scenario.evidence,
      message: "What are the pool and spa access rules?",
    });

    if (scenario.name === "preserved exception") {
      assert.equal(result.needsHuman, false);
    } else {
      assert.equal(result.needsHuman, true);
      assert.match(result.handoffReason, /lexical grounding requires staff review/i);
    }
  });
}
