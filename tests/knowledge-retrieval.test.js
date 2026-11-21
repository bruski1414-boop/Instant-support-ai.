const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRelevantKnowledgeContext,
  tokenize,
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
  assert.ok(result.length <= 130);
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
