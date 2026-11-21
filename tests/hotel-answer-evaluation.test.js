const test = require("node:test");
const assert = require("node:assert/strict");
const { hasRelevantKnowledgeMatch } = require("../knowledge-retrieval");
const { evaluateHotelAnswerCases } = require("../hotel-answer-evaluation");
const { buildEvidenceKnowledgeContext } = require("../knowledge-retrieval");
const { hasUnsupportedNumericClaims } = require("../guest-support-policy");

const syntheticHotelKnowledge = [
  { title: "Breakfast service", category: "dining", content: "Breakfast buffet is served daily from 7:00 to 10:00." },
  { title: "Swimming pool", category: "facilities", content: "The outdoor swimming pool is open from 8:00 to 20:00." },
  { title: "Internet access", category: "connectivity", content: "Wireless internet is available throughout the hotel." },
  { title: "Checkout policy", category: "front desk", content: "Departure and checkout time is 11:00." },
  { title: "Fitness centre", category: "facilities", content: "The gym and fitness centre are open from 6:00 to 22:00." },
  { title: "Restaurant hours", category: "dining", content: "The restaurant serves dinner from 18:00 to 22:00." },
  { title: "Spa treatments", category: "wellness", content: "Massage and spa treatments are available by appointment." },
  { title: "Airport transfers", category: "transport", content: "Airport transfers can be arranged through reception." },
  { title: "Laundry service", category: "guest services", content: "Laundry collection and return service is available daily." },
  { title: "Children's club", category: "family", content: "The children's club welcomes children aged 4 to 12 from 9:00 to 17:00." },
];

const supportedQuestions = [
  "When is breakfast?",
  "Can I swim in the pool?",
  "Is Wi-Fi available?",
  "What time is checkout?",
  "Where can I work out?",
  "When is dinner served at the restaurant?",
  "Can I book a massage?",
  "Can you arrange an airport transfer?",
  "Do you have a laundry service?",
  "What ages can use the children's club?",
];

const unsupportedQuestions = [
  "What is the price of breakfast?",
  "Can I book a helicopter transfer?",
  "What is the restaurant phone number?",
  "Can I bring my dog to the pool?",
  "What is the exact price of a spa treatment?",
  "Can you guarantee late checkout?",
  "Is there a private beach?",
  "Can you arrange a medical appointment?",
  "Can I reserve a yacht?",
  "Is airport transfer included for free?",
];

test("synthetic hotel evaluation: supported guest questions have matching approved evidence", () => {
  for (const question of supportedQuestions) {
    assert.equal(
      hasRelevantKnowledgeMatch(syntheticHotelKnowledge, question),
      true,
      `expected approved evidence for: ${question}`,
    );
  }
});

test("synthetic hotel evaluation: unsupported details fail closed despite related words", () => {
  for (const question of unsupportedQuestions) {
    assert.equal(
      hasRelevantKnowledgeMatch(syntheticHotelKnowledge, question),
      false,
      `expected no sufficient approved evidence for: ${question}`,
    );
  }
});

test("synthetic hotel evaluation dataset stays fictional and contains no guest records", () => {
  assert.equal(syntheticHotelKnowledge.length, 10);
  assert.ok(syntheticHotelKnowledge.every((item) =>
    typeof item.title === "string" &&
    typeof item.content === "string" &&
    !/email|phone number|passport|booking id/i.test(item.content)
  ));
});


test("end-to-end synthetic evaluator measures supported answers and safe handoffs", async () => {
  const supportedReplies = [
    "Breakfast buffet is served daily from 7:00 to 10:00.",
    "The outdoor swimming pool is open from 8:00 to 20:00.",
    "Wireless internet is available throughout the hotel.",
    "Departure and checkout time is 11:00.",
    "The gym and fitness centre are open from 6:00 to 22:00.",
    "The restaurant serves dinner from 18:00 to 22:00.",
    "Massage and spa treatments are available by appointment.",
    "Airport transfers can be arranged through reception.",
    "Laundry collection and return service is available daily.",
    "The children's club welcomes children aged 4 to 12 from 9:00 to 17:00.",
  ];
  const unsupportedReplies = [
    "Breakfast costs 500 THB per person.",
    "Reception can book a helicopter transfer for 2,500 THB.",
    "The restaurant phone number is 0123456789.",
    "Yes, dogs can use the pool.",
    "A spa treatment costs 3,000 THB.",
    "Late checkout is guaranteed until 15:00.",
    "Yes, the hotel has a private beach.",
    "We can arrange a medical appointment.",
    "Yes, you can reserve a yacht.",
    "Airport transfers are included for free.",
  ];
  const cases = [
    ...supportedQuestions.map((question, index) => ({
      id: `S${String(index + 1).padStart(2, "0")}`,
      question,
      expectedOutcome: "answer",
      mockReply: supportedReplies[index],
    })),
    ...unsupportedQuestions.map((question, index) => ({
      id: `H${String(index + 1).padStart(2, "0")}`,
      question,
      expectedOutcome: "handoff",
      mockReply: unsupportedReplies[index],
    })),
    {
      id: "H11",
      question: "When is breakfast?",
      expectedOutcome: "handoff",
      mockReply: "Breakfast is served from 6:00 to 11:00.",
    },
  ];

  const report = await evaluateHotelAnswerCases({
    hotelName: "Synthetic Test Hotel",
    documents: syntheticHotelKnowledge,
    cases,
  });

  assert.equal(report.total, 21);
  assert.equal(report.passed, 21, JSON.stringify(report.results.filter((item) => !item.passed)));
  assert.equal(report.failed, 0);
  assert.equal(report.accuracy, 1);
  assert.equal(report.answerCases, 10);
  assert.equal(report.handoffCases, 11);
  assert.equal(report.falseAccepts, 0);
  assert.equal(report.falseHandoffs, 0);
  assert.equal(report.results.find((item) => item.id === "H11").evidenceMatched, true);
});

test("end-to-end evaluator validates input and handles an empty suite", async () => {
  await assert.rejects(
    () => evaluateHotelAnswerCases({
      documents: syntheticHotelKnowledge,
      cases: [{ id: "bad", question: "Hello", expectedOutcome: "unknown", mockReply: "Hi" }],
    }),
    /Each evaluation case needs an id/,
  );
  const empty = await evaluateHotelAnswerCases({ documents: syntheticHotelKnowledge, cases: [] });
  assert.equal(empty.total, 0);
  assert.equal(empty.accuracy, 0);
});


test("breakfast numeric evidence cannot borrow gym or checkout times", () => {
  const evidence = buildEvidenceKnowledgeContext(syntheticHotelKnowledge, "When is breakfast?");
  assert.match(evidence, /Breakfast service/);
  assert.doesNotMatch(evidence, /Fitness centre|Checkout policy/);
  assert.equal(hasUnsupportedNumericClaims("Breakfast is served from 6:00 to 11:00.", evidence), true);
});


test("mixed-intent questions fail closed when only one part is supported", () => {
  const mixedQuestions = [
    "When is breakfast and how much does it cost?",
    "Is the pool open and can I bring my dog?",
    "What time is checkout and can you guarantee a late checkout?",
    "Can I use Wi-Fi and what is the password?",
    "When is dinner and can you reserve a yacht?",
    "Can I book a massage and what is the exact price?",
  ];

  for (const question of mixedQuestions) {
    assert.equal(
      hasRelevantKnowledgeMatch(syntheticHotelKnowledge, question),
      false,
      `expected the unsupported part to block a partial answer: ${question}`,
    );
  }
});

test("query evidence is not borrowed from a second unrelated document", () => {
  const splitEvidence = [
    { title: "Breakfast service", category: "dining", content: "Breakfast is served daily." },
    { title: "Room prices", category: "rates", content: "Prices vary by season." },
  ];
  assert.equal(
    hasRelevantKnowledgeMatch(splitEvidence, "What is the breakfast price?"),
    false,
  );
});
