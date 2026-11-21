const test = require("node:test");
const assert = require("node:assert/strict");
const { generateDemoHotelAnswer, DEMO_HOTEL_KNOWLEDGE } = require("../demo-hotel");

function fakeAi(content, inspect) {
  return {
    chat: {
      completions: {
        async create(request) {
          if (inspect) inspect(request);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

test("demo assistant uses only clearly fictional Northstar Hotel sample facts", async () => {
  let request;
  const result = await generateDemoHotelAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "Check-in begins at 3:00 PM.",
      needsHuman: false,
      handoffReason: "",
    }), (value) => { request = value; }),
    model: "test-model",
    message: "When is check-in?",
  });

  assert.equal(result.reply, "Check-in begins at 3:00 PM.");
  assert.equal(result.needsHuman, false);
  assert.match(request.messages[0].content, /Northstar Hotel \(fictional demo\)/);
  assert.match(request.messages[0].content, /invented sample data/);
  assert.match(request.messages[0].content, /Check-in begins at 3:00 PM/);
  assert.match(DEMO_HOTEL_KNOWLEDGE, /no verified local attractions/);
});

test("demo assistant always hands booking and reservation requests to staff", async () => {
  const result = await generateDemoHotelAnswer({
    ai: fakeAi(JSON.stringify({
      reply: "I can book that for you.",
      needsHuman: false,
      handoffReason: "",
    })),
    model: "test-model",
    message: "Can you confirm a reservation?",
  });

  assert.equal(result.needsHuman, true);
  assert.match(result.reply, /contact the front desk directly/i);
});
