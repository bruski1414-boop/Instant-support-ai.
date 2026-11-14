"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRelevantKnowledge, scoreDocument } = require("../hotel-knowledge");

const docs = [
  {
    title: "Breakfast service",
    category: "Dining",
    content: "Breakfast is served in the Garden Restaurant from 06:30 until 10:30.",
    source_reference: "Hotel handbook, dining section",
    reviewed_at: "2026-10-01T00:00:00.000Z",
    review_due_at: "2027-01-01"
  },
  {
    title: "Pool rules",
    category: "Facilities",
    content: "The outdoor pool is open from 08:00 until 20:00. Children must be supervised.",
    source_reference: "Pool operations policy",
    reviewed_at: "2026-10-01T00:00:00.000Z",
    review_due_at: "2027-01-01"
  },
  {
    title: "Airport transfers",
    category: "Transport",
    content: "The concierge can explain available airport transfer options.",
    source_reference: "Guest services guide",
    reviewed_at: null,
    review_due_at: null
  }
];

test("prioritises documents matching the guest question", () => {
  const result = buildRelevantKnowledge("What time is breakfast?", docs);
  assert.equal(result.matched, true);
  assert.match(result.context, /Breakfast service/);
  assert.doesNotMatch(result.context, /Pool rules/);
  assert.equal(result.selectedCount, 1);
});

test("uses category and body matches when the title differs", () => {
  const score = scoreDocument(["swimming", "pool"], docs[1]);
  assert.ok(score > 0);
  const result = buildRelevantKnowledge("swimming pool", docs);
  assert.match(result.context, /Pool rules/);
});

test("returns no unrelated documents when wording does not match", () => {
  const result = buildRelevantKnowledge("Do you have a quiet place for reading?", docs);
  assert.equal(result.matched, false);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.noRelevantKnowledge, true);
  assert.equal(result.selectedCount, 0);
  assert.equal(result.context, "");
});

test("respects document and character limits", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    title: "Hotel policy " + i,
    category: "General",
    content: "Hotel policy information " + i + " includes guest guidance."
  }));
  const result = buildRelevantKnowledge("hotel policy", many, { maxDocuments: 3, maxCharacters: 1000 });
  assert.ok(result.selectedCount <= 3);
  assert.ok(result.context.length <= 1000);
});

test("rejects invalid questions, input lists and unsafe limits", () => {
  assert.throws(() => buildRelevantKnowledge("", docs), /question is required/);
  assert.throws(() => buildRelevantKnowledge("breakfast", {}), /must be a list/);
  assert.throws(() => buildRelevantKnowledge("breakfast", docs, { maxDocuments: 100 }), /outside the permitted range/);
});
