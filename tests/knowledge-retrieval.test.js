const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRelevantKnowledgeContext,
  tokenize,
  expandQueryTokens,
  hasRelevantKnowledgeMatch,
} = require("../knowledge-retrieval");

const docs = [
  { title: "Breakfast service", category: "dining", content: "Breakfast is served daily from 7:00 to 10:00." },
  { title: "Swimming pool", category: "facilities", content: "The outdoor pool is open from 8:00 to 20:00." },
  { title: "Airport transfers", category: "transport", content: "Airport transfers can be arranged through reception." },
];

test("small approved knowledge sets remain complete and in source order", () => {
  const result = buildRelevantKnowledgeContext(docs, "What time is breakfast?");
  assert.ok(result.indexOf("Breakfast service") < result.indexOf("Swimming pool"));
  assert.ok(result.includes("Airport transfers"));
});

test("large knowledge sets prioritize relevant title and category matches", () => {
  const largeDocs = [
    ...docs,
    { title: "Spa treatments", category: "wellness", content: "Massage appointments are available." },
    { title: "Breakfast menu", category: "dining", content: "The breakfast buffet includes fruit and pastries." },
  ];
  const result = buildRelevantKnowledgeContext(largeDocs, "breakfast", { maxChars: 180 });
  assert.match(result, /Breakfast service/);
  assert.match(result, /Breakfast menu/);
  assert.doesNotMatch(result, /Airport transfers/);
  assert.ok(result.length <= 180);
});

test("irrelevant queries fail closed when the full knowledge set exceeds the context budget", () => {
  const largeDocs = docs.map((doc) => ({ ...doc, content: doc.content + " ".repeat(100) }));
  assert.equal(buildRelevantKnowledgeContext(largeDocs, "quantum teleportation", { maxChars: 80 }), "");
});

test("a relevant document that cannot fit is skipped rather than cut mid-fact", () => {
  const longDoc = { title: "Breakfast", category: "dining", content: "A".repeat(300) };
  const result = buildRelevantKnowledgeContext([longDoc, docs[1]], "breakfast", { maxChars: 100 });
  assert.equal(result, "");
});

test("tokenization removes common filler words and deduplicates are handled by caller", () => {
  assert.deepEqual(tokenize("What time is breakfast for your room?"), ["time", "breakfast", "room"]);
});

test("malformed documents are ignored", () => {
  const result = buildRelevantKnowledgeContext([
    null,
    { title: "No content", content: "" },
    { title: "Pool", content: "Open from 8 to 8." },
  ], "pool");
  assert.match(result, /Pool/);
});

test("common guest paraphrases expand to hotel knowledge terms", () => {
  assert.ok(expandQueryTokens(tokenize("When is the morning meal served?"), "When is the morning meal served?").includes("breakfast"));
  assert.ok(expandQueryTokens(tokenize("Can I use the swimming area?")).includes("pool"));
  assert.ok(expandQueryTokens(tokenize("Is wireless internet available?")).includes("wifi"));
  assert.ok(expandQueryTokens(tokenize("What time is departure?"), "What time is departure?").includes("checkout"));
});

test("paraphrased guest questions retrieve matching approved documents", () => {
  const expandedDocs = [
    { title: "Breakfast service", category: "dining", content: "The buffet is served from 7:00 to 10:00." },
    { title: "Pool facilities", category: "facilities", content: "The swimming pool is open from 8:00 to 20:00." },
    { title: "Internet access", category: "connectivity", content: "Wireless internet is available throughout the hotel." },
    { title: "Checkout policy", category: "front desk", content: "Departure time is 11:00." },
    { title: "Airport transport", category: "transport", content: "Transfers can be arranged at reception." },
  ];
  const breakfast = buildRelevantKnowledgeContext(expandedDocs, "When is the morning meal served?", { maxChars: 180 });
  assert.match(breakfast, /Breakfast service/);
  const internet = buildRelevantKnowledgeContext(expandedDocs, "Is wireless internet available?", { maxChars: 180 });
  assert.match(internet, /Internet access/);
  const checkout = buildRelevantKnowledgeContext(expandedDocs, "What time is departure?", { maxChars: 180 });
  assert.match(checkout, /Checkout policy/);
});

test("wellness, fitness and dining paraphrases retrieve their approved hotel documents", () => {
  const domainDocs = [
    { title: "Spa treatments", category: "wellness", content: "Massage appointments are available by reservation." },
    { title: "Fitness centre", category: "facilities", content: "The gym is open from 6:00 to 22:00." },
    { title: "Restaurant hours", category: "dining", content: "The restaurant serves dinner from 18:00." },
    { title: "Laundry service", category: "guest services", content: "Laundry collection is available daily." },
  ];
  const cases = [
    ["Can I book a massage?", "Spa treatments"],
    ["Where can I do a workout?", "Fitness centre"],
    ["What time does the restaurant open?", "Restaurant hours"],
  ];
  for (const [query, expectedTitle] of cases) {
    const context = buildRelevantKnowledgeContext(domainDocs, query, { maxChars: 180 });
    assert.ok(context.includes(expectedTitle), `expected "${query}" to retrieve ${expectedTitle}`);
  }
});

test("strict evidence matching accepts a supported FAQ question in a small knowledge base", () => {
  const smallDocs = [
    { title: "Breakfast service", category: "dining", content: "Breakfast is served daily from 7:00 to 10:00." },
    { title: "Swimming pool", category: "facilities", content: "The outdoor pool is open from 8:00 to 20:00." },
  ];
  assert.equal(hasRelevantKnowledgeMatch(smallDocs, "What time is breakfast served?"), true);
  assert.equal(hasRelevantKnowledgeMatch(smallDocs, "Can I use the swimming area?"), true);
});

test("strict evidence matching rejects unsupported details even when one word overlaps", () => {
  const smallDocs = [
    { title: "Airport transfers", category: "transport", content: "Airport transfers can be arranged through reception." },
    { title: "Breakfast service", category: "dining", content: "Breakfast is served from 7:00 to 10:00." },
  ];
  assert.equal(hasRelevantKnowledgeMatch(smallDocs, "What is the price of a helicopter transfer?"), false);
  assert.equal(hasRelevantKnowledgeMatch(smallDocs, "Can you arrange a helicopter transfer?"), false);
  assert.equal(hasRelevantKnowledgeMatch(smallDocs, "Tell me about quantum teleportation"), false);
});

test("strict evidence matching handles approved hotel terminology synonyms", () => {
  const docs = [
    { title: "Internet access", category: "connectivity", content: "Wireless internet is available throughout the hotel." },
    { title: "Checkout policy", category: "front desk", content: "Departure time is 11:00." },
    { title: "Spa treatments", category: "wellness", content: "Massage appointments are available by reservation." },
  ];
  assert.equal(hasRelevantKnowledgeMatch(docs, "Is Wi-Fi available?"), true);
  assert.equal(hasRelevantKnowledgeMatch(docs, "What time is departure?"), true);
  assert.equal(hasRelevantKnowledgeMatch(docs, "Can I book a massage?"), true);
});

test("strict evidence matching fails closed for empty or generic questions", () => {
  assert.equal(hasRelevantKnowledgeMatch([], "When is breakfast?"), false);
  assert.equal(hasRelevantKnowledgeMatch(docs, "Hello, can you help me?"), false);
});


test("strict evidence matching accepts natural phrasing without requiring filler words in hotel documents", () => {
  const docs = [
    { title: "Breakfast service", category: "dining", content: "Breakfast is served daily from 7:00 to 10:00." },
    { title: "Pool facilities", category: "facilities", content: "The outdoor swimming pool is open from 8:00 to 20:00." },
    { title: "Internet access", category: "connectivity", content: "Wireless internet is available throughout the hotel." },
  ];
  assert.equal(hasRelevantKnowledgeMatch(docs, "What are the breakfast hours?"), true);
  assert.equal(hasRelevantKnowledgeMatch(docs, "Does your hotel offer a swimming pool?"), true);
  assert.equal(hasRelevantKnowledgeMatch(docs, "Can I get wireless internet?"), true);
});

test("strict evidence matching does not confuse a topic match with support for a new detail", () => {
  const docs = [
    { title: "Breakfast service", category: "dining", content: "Breakfast is served daily from 7:00 to 10:00." },
    { title: "Airport transfers", category: "transport", content: "Airport transfers can be arranged through reception." },
  ];
  assert.equal(hasRelevantKnowledgeMatch(docs, "What time is breakfast for children?"), false);
  assert.equal(hasRelevantKnowledgeMatch(docs, "How much is a helicopter transfer?"), false);
  assert.equal(hasRelevantKnowledgeMatch(docs, "Is breakfast included in the room rate?"), false);
});


test("synthetic hotel FAQ evaluation covers common supported guest intents", () => {
  const hotelFaq = [
    { title: "Breakfast service", category: "dining", content: "Breakfast is served daily from 7:00 to 10:00." },
    { title: "Swimming pool", category: "facilities", content: "The outdoor swimming pool is open from 8:00 to 20:00." },
    { title: "Internet access", category: "connectivity", content: "Wireless internet is available throughout the hotel." },
    { title: "Check-in policy", category: "front desk", content: "Check-in begins at 15:00." },
    { title: "Checkout policy", category: "front desk", content: "Departure time is 11:00." },
    { title: "Fitness centre", category: "facilities", content: "The gym is open from 6:00 to 22:00." },
    { title: "Spa treatments", category: "wellness", content: "Massage appointments are available by reservation." },
    { title: "Restaurant hours", category: "dining", content: "The restaurant serves dinner from 18:00." },
    { title: "Airport transfers", category: "transport", content: "Airport transfers can be arranged through reception." },
  ];
  const supportedQuestions = [
    "When is the morning meal served?",
    "Does your hotel offer a swimming pool?",
    "Can I connect to the Wi-Fi?",
    "When does check-in begin?",
    "What time is departure?",
    "Where can I do a workout?",
    "How do I book a massage?",
    "When does dinner start?",
    "Can I arrange an airport transfer?",
  ];
  for (const question of supportedQuestions) {
    assert.equal(
      hasRelevantKnowledgeMatch(hotelFaq, question),
      true,
      `expected approved FAQ evidence for: ${question}`,
    );
    assert.ok(
      buildRelevantKnowledgeContext(hotelFaq, question).length > 0,
      `expected a non-empty context for: ${question}`,
    );
  }
});

test("synthetic hotel FAQ evaluation rejects requests for unsupported facts", () => {
  const hotelFaq = [
    { title: "Breakfast service", category: "dining", content: "Breakfast is served daily from 7:00 to 10:00." },
    { title: "Airport transfers", category: "transport", content: "Airport transfers can be arranged through reception." },
    { title: "Spa treatments", category: "wellness", content: "Massage appointments are available by reservation." },
  ];
  const unsupportedQuestions = [
    "How much does a helicopter transfer cost?",
    "Are dogs allowed in guest rooms?",
    "Is breakfast included in my room rate?",
    "Can the hotel guarantee a sea-view upgrade?",
    "What time does room service stop?",
  ];
  for (const question of unsupportedQuestions) {
    assert.equal(
      hasRelevantKnowledgeMatch(hotelFaq, question),
      false,
      `expected staff handoff for unsupported question: ${question}`,
    );
  }
});
