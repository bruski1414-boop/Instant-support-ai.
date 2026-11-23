"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectCases } = require("../scripts/evaluate-live-guest-support");
const { cases } = require("./fixtures/guest-support-benchmark");

test("small live evaluation limits include multiple categories", () => {
  const selected = selectCases(cases, 3);
  assert.equal(selected.length, 3);
  assert.deepEqual(new Set(selected.map((item) => item.category)), new Set([
    "supported_fact",
    "unsupported_fact",
    "sensitive_request",
  ]));
});

test("five-case live evaluation is balanced across categories", () => {
  const selected = selectCases(cases, 5);
  const counts = Object.fromEntries(
    ["supported_fact", "unsupported_fact", "sensitive_request"].map((category) => [
      category,
      selected.filter((item) => item.category === category).length,
    ])
  );
  assert.deepEqual(counts, {
    supported_fact: 2,
    unsupported_fact: 2,
    sensitive_request: 1,
  });
});

test("full live evaluation selects all 100 unique cases", () => {
  const selected = selectCases(cases, 100);
  assert.equal(selected.length, 100);
  assert.deepEqual(new Set(selected.map((item) => item.id)), new Set(cases.map((item) => item.id)));
});

test("live evaluation rejects invalid limits", () => {
  for (const limit of [0, -1, 1.5, 101, NaN]) {
    assert.throws(() => selectCases(cases, limit));
  }
});
