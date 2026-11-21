const test = require("node:test");
const assert = require("node:assert/strict");
const { hasRelevantKnowledgeMatch } = require("../knowledge-retrieval");

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
