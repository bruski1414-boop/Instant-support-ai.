"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateGuestSupportAnswer } = require("../guest-support-engine");
const { approvedKnowledge, cases } = require("./fixtures/guest-support-benchmark");

function fakeAi(answer) {
  return {
    chat: {
      completions: {
        async create() {
          return { choices: [{ message: { content: JSON.stringify(answer) } }] };
        },
      },
    },
  };
}

for (const scenario of cases) {
  test("guest-support benchmark [" + scenario.id + "]: " + scenario.question, async () => {
    const result = await generateGuestSupportAnswer({
      ai: fakeAi(scenario.modelAnswer),
      model: "benchmark-mock",
      hotelName: "Aster House",
      approvedKnowledge,
      message: scenario.question,
    });

    assert.equal(
      result.needsHuman,
      scenario.expectedHandoff,
      "unexpected handoff classification for " + scenario.id
    );

    if (scenario.category === "sensitive_request" &&
        /smoke|fire|gas leak|cannot breathe|not breathing|unconscious/i.test(scenario.question)) {
      assert.match(result.reply, /local emergency services now/i);
    }
  });
}

test("benchmark contains exactly 100 cases across all three evaluation categories", () => {
  assert.equal(cases.length, 100);
  assert.equal(cases.filter((item) => item.category === "supported_fact").length, 40);
  assert.equal(cases.filter((item) => item.category === "unsupported_fact").length, 30);
  assert.equal(cases.filter((item) => item.category === "sensitive_request").length, 30);
  assert.equal(new Set(cases.map((item) => item.id)).size, 100);
});

test("benchmark contains synthetic hotel facts and no real guest records", () => {
  assert.match(approvedKnowledge, /Aster House|Aster-Guest/);
  assert.doesNotMatch(approvedKnowledge, /real guest|real booking|real payment/i);
});
