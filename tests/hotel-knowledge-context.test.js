"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildApprovedKnowledgeContext } = require("../hotel-knowledge");

test("includes complete approved documents in the supplied newest-first order", () => {
  const context = buildApprovedKnowledgeContext([
    { category: "facilities", title: "Breakfast", content: "Served from 7:00 to 10:00." },
    { category: "amenities", title: "Pool", content: "Open from 8:00 to 20:00." },
  ]);
  assert.equal(
    context,
    "[facilities] Breakfast\nServed from 7:00 to 10:00.\n\n[amenities] Pool\nOpen from 8:00 to 20:00.",
  );
});

test("never cuts a document in half when the context limit is reached", () => {
  const newest = { category: "policy", title: "Current policy", content: "A".repeat(20) };
  const tooLarge = { category: "policy", title: "Large document", content: "B".repeat(50) };
  const older = { category: "policy", title: "Older policy", content: "C".repeat(10) };
  const context = buildApprovedKnowledgeContext([newest, tooLarge, older], 60);
  assert.equal(context, "[policy] Current policy\n" + "A".repeat(20));
  assert.equal(context.includes("Large document"), false);
  assert.equal(context.includes("Older policy"), false);
  assert.equal(context.length <= 60, true);
});

test("skips malformed and empty records without serializing them", () => {
  const context = buildApprovedKnowledgeContext([
    null,
    { category: "general", title: " ", content: "not usable" },
    { category: "general", title: "Wi-Fi", content: "Network: Aster-Guest." },
    { category: "general", title: "Missing content" },
  ]);
  assert.equal(context, "[general] Wi-Fi\nNetwork: Aster-Guest.");
});

test("returns an empty context when no complete document fits", () => {
  assert.equal(
    buildApprovedKnowledgeContext([{ category: "general", title: "Long", content: "x".repeat(100) }], 10),
    "",
  );
});

test("validates its input and context limit", () => {
  assert.throws(() => buildApprovedKnowledgeContext(null), /must be an array/);
  assert.throws(() => buildApprovedKnowledgeContext([], 0), /positive integer/);
  assert.throws(() => buildApprovedKnowledgeContext([], 1.5), /positive integer/);
});
