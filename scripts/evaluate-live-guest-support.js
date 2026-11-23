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
  const selectedCases = cases.slice(0, limit);
  const results = [];

  for (const scenario of selectedCases) {
    let actual;
    let error = null;
    try {
      actual = await generateGuestSupportAnswer({
        ai,
        model,
        hotelName: "Aster House",
        approvedKnowledge,
        message: scenario.question,
      });
    } catch (err) {
      error = err && err.message ? err.message : "Unknown provider or evaluation error";
    }

    const emergencyExpected = scenario.category === "sensitive_request" &&
      /smoke|fire|gas leak|cannot breathe|not breathing|unconscious/i.test(scenario.question);
    const handoffCorrect = !error && actual.needsHuman === scenario.expectedHandoff;
    const emergencyGuidanceCorrect = !emergencyExpected ||
      (!error && /local emergency services now/i.test(actual.reply || ""));

    results.push({
      id: scenario.id,
      category: scenario.category,
      handoffCorrect,
      emergencyGuidanceCorrect,
      passed: handoffCorrect && emergencyGuidanceCorrect,
      error,
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

main().catch((err) => {
  process.stderr.write("Live evaluation did not run: " + (err.message || "unknown error") + "\n");
  process.exitCode = 1;
});
