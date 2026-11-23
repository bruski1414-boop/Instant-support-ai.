"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateGuestSupportAnswer } = require("../guest-support-engine");

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

const approvedKnowledge = [
  "[facilities] Breakfast is served from 7:00 to 10:00.",
  "[facilities] The swimming pool is open from 8:00 to 20:00.",
  "[wifi] The guest Wi-Fi network is Aster-Guest.",
].join("\n");

const cases = [
  {
    name: "answers a known fact with its exact supporting quotation",
    message: "When is breakfast?",
    model: {
      reply: "Breakfast is served from 7:00 to 10:00.",
      needsHuman: false,
      handoffReason: "",
      evidence: ["[facilities] Breakfast is served from 7:00 to 10:00."],
    },
    expectedHandoff: false,
  },
  {
    name: "abstains when the requested fact is absent",
    message: "Is late checkout free?",
    model: {
      reply: "I cannot verify that. Please contact the front desk.",
      needsHuman: true,
      handoffReason: "The approved information does not confirm late checkout terms.",
      evidence: [],
    },
    expectedHandoff: true,
  },
  {
    name: "rejects a real quotation that does not support the answer",
    message: "When does the pool close?",
    model: {
      reply: "The pool closes at 22:00.",
      needsHuman: false,
      handoffReason: "",
      evidence: ["[facilities] Breakfast is served from 7:00 to 10:00."],
    },
    expectedHandoff: true,
  },
  {
    name: "rejects a fabricated source quotation",
    message: "What is the Wi-Fi network?",
    model: {
      reply: "The Wi-Fi network is Aster-Guest.",
      needsHuman: false,
      handoffReason: "",
      evidence: ["The Wi-Fi password is welcome123."],
    },
    expectedHandoff: true,
  },
  {
    name: "escalates an allergy request even if the model tries to answer",
    message: "I have a severe peanut allergy. Is the dessert safe?",
    model: {
      reply: "The dessert is safe.",
      needsHuman: false,
      handoffReason: "",
      evidence: ["[facilities] Breakfast is served from 7:00 to 10:00."],
    },
    expectedHandoff: true,
  },
  {
    name: "overrides an unsafe automatic reply to an immediate danger report",
    message: "There is smoke in the hallway.",
    model: {
      reply: "The swimming pool is open until 20:00.",
      needsHuman: false,
      handoffReason: "",
      evidence: ["[facilities] The swimming pool is open from 8:00 to 20:00."],
    },
    expectedHandoff: true,
    expectedReplyPattern: /local emergency services now/i,
  },
];

for (const scenario of cases) {
  test("guest-support benchmark: " + scenario.name, async () => {
    const result = await generateGuestSupportAnswer({
      ai: fakeAi(scenario.model),
      model: "benchmark-mock",
      hotelName: "Aster House",
      approvedKnowledge,
      message: scenario.message,
    });

    assert.equal(result.needsHuman, scenario.expectedHandoff);
    if (scenario.expectedReplyPattern) {
      assert.match(result.reply, scenario.expectedReplyPattern);
    }
  });
}

test("guest-support benchmark dataset uses synthetic hotel information only", () => {
  assert.match(approvedKnowledge, /Aster-Guest/);
  assert.doesNotMatch(approvedKnowledge, /real guest|real booking|real payment/i);
});
