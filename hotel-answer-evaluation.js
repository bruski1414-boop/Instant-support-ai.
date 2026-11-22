"use strict";

const {
  buildRelevantKnowledgeContext,
  hasRelevantKnowledgeMatch,
  buildEvidenceKnowledgeContext,
} = require("./knowledge-retrieval");
const {
  generateGuestSupportAnswer,
  createNoKnowledgeAnswer,
} = require("./guest-support-engine");

function createMockAi(content) {
  return {
    chat: {
      completions: {
        async create() {
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

async function evaluateHotelAnswerCases({
  hotelName = "Synthetic Test Hotel",
  documents,
  cases,
}) {
  if (!Array.isArray(documents) || !Array.isArray(cases)) {
    throw new TypeError("documents and cases must be arrays.");
  }

  const results = [];
  for (const item of cases) {
    if (
      !item ||
      typeof item.id !== "string" ||
      typeof item.question !== "string" ||
      !["answer", "handoff"].includes(item.expectedOutcome) ||
      typeof item.mockReply !== "string"
    ) {
      throw new TypeError("Each evaluation case needs an id, question, expectedOutcome and mockReply.");
    }

    const hasEvidence = hasRelevantKnowledgeMatch(documents, item.question);
    const context = hasEvidence
      ? buildRelevantKnowledgeContext(documents, item.question)
      : "";
    const actual = hasEvidence && context
      ? await generateGuestSupportAnswer({
          ai: createMockAi(JSON.stringify({
            reply: item.mockReply,
            needsHuman: Boolean(item.modelRequestsHandoff),
            handoffReason: item.modelRequestsHandoff ? "Synthetic evaluator requested staff review." : "",
          })),
          model: "synthetic-evaluation-model",
          hotelName,
          approvedKnowledge: context,
          numericEvidence: buildEvidenceKnowledgeContext(documents, item.question),
          message: item.question,
        })
      : createNoKnowledgeAnswer(item.question);

    const actualOutcome = actual.needsHuman ? "handoff" : "answer";
    results.push({
      id: item.id,
      question: item.question,
      expectedOutcome: item.expectedOutcome,
      actualOutcome,
      passed: actualOutcome === item.expectedOutcome,
      evidenceMatched: hasEvidence,
      handoffReason: actual.handoffReason || "",
    });
  }

  const answerCases = results.filter((item) => item.expectedOutcome === "answer");
  const handoffCases = results.filter((item) => item.expectedOutcome === "handoff");
  const falseAccepts = handoffCases.filter((item) => item.actualOutcome === "answer").length;
  const falseHandoffs = answerCases.filter((item) => item.actualOutcome === "handoff").length;
  const passed = results.filter((item) => item.passed).length;

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    accuracy: results.length ? Number((passed / results.length).toFixed(4)) : 0,
    answerCases: answerCases.length,
    handoffCases: handoffCases.length,
    falseAccepts,
    falseHandoffs,
    results,
  };
}

module.exports = { evaluateHotelAnswerCases };
