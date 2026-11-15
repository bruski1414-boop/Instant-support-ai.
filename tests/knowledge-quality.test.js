"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeKnowledgeQuality } = require("../knowledge-quality");

test("flags unapproved, unsourced, unreviewed and overdue documents", () => {
  const result = analyzeKnowledgeQuality([{
    id: "doc-1", title: "Pool hours", category: "facilities",
    content: "The pool opens at 7:00 and closes at 20:00.",
    approved: false, source_reference: "", reviewed_at: null, review_due_at: "2026-11-01"
  }], "2026-11-15");
  const codes = result.findings.map(item => item.code);
  assert.ok(codes.includes("not_approved"));
  assert.ok(codes.includes("missing_source"));
  assert.ok(codes.includes("never_reviewed"));
  assert.ok(codes.includes("review_overdue"));
  assert.equal(result.blockingCount, 2);
});

test("flags missing review dates and very thin content", () => {
  const result = analyzeKnowledgeQuality([{
    id: "doc-2", title: "Parking", category: "facilities",
    content: "Parking available.", approved: true, source_reference: "Hotel handbook",
    reviewed_at: "2026-11-01", review_due_at: null
  }], "2026-11-15");
  assert.ok(result.findings.some(item => item.code === "missing_review_date"));
  assert.ok(result.findings.some(item => item.code === "thin_content"));
});

test("detects possible conflicting values but never chooses one automatically", () => {
  const result = analyzeKnowledgeQuality([
    { id: "a", title: "Breakfast opening hours", category: "dining", content: "Breakfast is open 6:30 to 10:30.", approved: true },
    { id: "b", title: "Breakfast service hours", category: "dining", content: "Breakfast is open 7:00 to 11:00.", approved: true }
  ], "2026-11-15");
  assert.equal(result.possibleConflictCount, 1);
  assert.equal(result.possibleConflicts[0].severity, "review_required");
  assert.match(result.note, /never resolves conflicting/i);
});

test("does not compare unrelated categories or titles", () => {
  const result = analyzeKnowledgeQuality([
    { title: "Breakfast hours", category: "dining", content: "6:30 to 10:30" },
    { title: "Pool opening", category: "facilities", content: "7:00 to 20:00" }
  ]);
  assert.equal(result.possibleConflictCount, 0);
});
