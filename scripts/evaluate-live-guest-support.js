"use strict";

// Explicitly opt-in live-model evaluation. Uses fictional Aster House fixtures only.
// This makes real provider requests and may incur charges; obtain account-owner
// approval and set a strict case limit before running.

const OpenAI = require("openai");
const { generateGuestSupportAnswer } = require("../guest-support-engine");
const { approvedKnowledge, cases } = require("../tests/fixtures/guest-support-benchmark");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

// Spread small runs across supported, unsupported and sensitive categories.
// This prevents a low request limit from testing only the first category.
function selectCases(allCases, limit) {
  if (!Array.isArray(allCases) || !Number.isSafeInteger(limit) || limit < 1 || limit > allCases.length) {
    throw new Error("A valid case array and limit from 1 to the case count are required.");
  }

  const groups = new Map();
  for (const scenario of allCases) {
    if (!groups.has(scenario.category)) groups.set(scenario.category, []);
    groups.get(scenario.category).push(scenario);
  }

  const selected = [];
  const queues = Array.from(groups.values());
  while (selected.length < limit) {
    let added = false;
    for (const queue of queues) {
      if (queue.length && selected.length < limit) {
        selected.push(queue.shift());
        added = true;
      }
    }
    if (!added) break;
  }
  return selected;
}

async function main() {
  if (process.env.VEYRA_LIVE_EVAL_APPROVED !== "YES") {
    throw new Error("Live evaluation blocked. Obtain approval from the API account owner, then set VEYRA_LIVE_EVAL_APPROVED=YES.");
  }

  const apiKey = required("OPENAI_API_KEY");
  const model = required("VEYRA_AI_MODEL");
  const limitText = required("VEYRA_LIVE_EVAL_LIMIT");
  if (!/^\d+$/.test(limitText)) {
    throw new Error("VEYRA_LIVE_EVAL_LIMIT must be an explicit integer from 1 to " + cases.length + ".");
  }
  const limit = Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cases.length) {
    throw new Error("VEYRA_LIVE_EVAL_LIMIT must be an explicit integer from 1 to " + cases.length + ".");
  }

  const ai = new OpenAI({
    apiKey,
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  });
  const selectedCases = selectCases(cases, limit);
  const results = [];

  for (const scenario of selectedCases) {
    let actual;
    try {
      actual = await generateGuestSupportAnswer({
        ai,
        model,
        hotelName: "Aster House",
        approvedKnowledge,
        message: scenario.question,
      });
    } catch (err) {
      // Stop on the first provider failure so a broken key/model does not
      // trigger up to the entire request budget in repeated failing calls.
      throw new Error("Evaluation stopped at " + scenario.id + ": " +
        (err && err.message ? err.message : "unknown provider or evaluation error"));
    }

    const emergencyExpected = scenario.category === "sensitive_request" &&
      /smoke|fire|gas leak|cannot breathe|not breathing|unconscious/i.test(scenario.question);
    const handoffCorrect = actual.needsHuman === scenario.expectedHandoff;
    const emergencyGuidanceCorrect = !emergencyExpected ||
      /local emergency services now/i.test(actual.reply || "");

    results.push({
      id: scenario.id,
      category: scenario.category,
      handoffCorrect,
      emergencyGuidanceCorrect,
      passed: handoffCorrect && emergencyGuidanceCorrect,
      error: null,
    });
  }

  const count = (predicate) => results.filter(predicate).length;
  const summary = {
    model,
    hotelKnowledge: "synthetic Aster House only",
    casesRun: results.length,
    casesAvailable: cases.length,
    passed: count((item) => item.passed),
    failed: count((item) => !item.passed),
    handoffClassificationCorrect: count((item) => item.handoffCorrect),
    emergencyGuidanceCorrect: count((item) => item.emergencyGuidanceCorrect),
    byCategory: {
      supported_fact: {
        total: count((item) => item.category === "supported_fact"),
        passed: count((item) => item.category === "supported_fact" && item.passed),
      },
      unsupported_fact: {
        total: count((item) => item.category === "unsupported_fact"),
        passed: count((item) => item.category === "unsupported_fact" && item.passed),
      },
      sensitive_request: {
        total: count((item) => item.category === "sensitive_request"),
        passed: count((item) => item.category === "sensitive_request" && item.passed),
      },
    },
    failedCaseIds: results.filter((item) => !item.passed).map((item) => item.id),
    limitations: [
      "This automated score checks handoff classification and emergency wording, not full semantic answer correctness.",
      "A human reviewer must compare every automatic answer with approved source knowledge before pilot use.",
      "This synthetic evaluation is not evidence of hotel readiness or guest outcomes.",
    ],
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  if (summary.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write("Live evaluation did not run: " + (err.message || "unknown error") + "\n");
    process.exitCode = 1;
  });
}

module.exports = { selectCases };
