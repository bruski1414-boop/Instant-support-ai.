const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateGuestSupportAnswer } = require("../guest-support-engine");

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
      evidence: ["[facilities] Breakfast: 7:00–10:00"],
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
  assert.equal("evidence" in result, false, "evidence is not exposed unless explicitly requested");
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


test("guest-support engine rejects automatic answers with missing or fabricated evidence", async () => {
  for (const evidence of [undefined, ["Breakfast is served all day."], []]) {
    const result = await generateGuestSupportAnswer({
      ai: fakeAi(JSON.stringify({
        reply: "Breakfast is served from 7:00 to 10:00.",
        needsHuman: false,
        handoffReason: "",
        ...(evidence === undefined ? {} : { evidence }),
      })),
      model: "test-model",
      hotelName: "Aster House",
      approvedKnowledge: "Breakfast is served from 7:00 to 10:00.",
      message: "When is breakfast?",
    });
    assert.equal(result.needsHuman, true);
    assert.match(result.reply, /cannot verify that answer/i);
    assert.match(result.handoffReason, /exact approved-knowledge evidence/);
  }
});


test("guest-support engine rejects valid but unrelated evidence for a concrete answer", async () => {
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "The swimming pool is open from 8:00 to 20:00.",
      needsHuman: false,
      handoffReason: "",
      evidence: ["[facilities] Breakfast: 7:00–10:00"],
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: "[facilities] Breakfast: 7:00–10:00",
    message: "What are the swimming pool hours?",
  });

  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /cannot verify that answer/i);
  assert.match(result.handoffReason, /exact approved-knowledge evidence/);
});


test("guest-support engine includes validated evidence only when explicitly requested", async () => {
  const evidence = "[facilities] Breakfast: 7:00–10:00";
  const result = await generateGuestSupportAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "Breakfast is served from 7:00 to 10:00.",
      needsHuman: false,
      handoffReason: "",
      evidence: [evidence],
    })),
    model: "test-model",
    hotelName: "Aster House",
    approvedKnowledge: evidence,
    message: "When is breakfast?",
    includeEvidence: true,
  });

  assert.equal(result.needsHuman, false);
  assert.deepEqual(result.evidence, [evidence]);
});
