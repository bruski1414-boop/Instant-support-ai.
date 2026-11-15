"use strict";

function words(value) {
  return [...new Set((String(value || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []))];
}
function numbers(value) {
  return [...new Set((String(value || "").match(/\b\d+(?:[.:]\d+)?\b/g) || []))].sort();
}
function dateOnly(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function analyzeKnowledgeQuality(documents, today = new Date().toISOString().slice(0, 10)) {
  if (!Array.isArray(documents)) throw new Error("Knowledge documents must be a list.");
  const findings = [];
  const reviewed = documents.map((doc, index) => {
    const issues = [];
    const due = dateOnly(doc.review_due_at);
    if (doc.approved !== true) issues.push({ code: "not_approved", severity: "blocking", message: "Document has not been approved by a hotel manager." });
    if (!String(doc.source_reference || "").trim()) issues.push({ code: "missing_source", severity: "warning", message: "No source reference is recorded." });
    if (!doc.reviewed_at) issues.push({ code: "never_reviewed", severity: "warning", message: "No manager review date is recorded." });
    if (due && due < today) issues.push({ code: "review_overdue", severity: "blocking", message: "Scheduled review date has passed." });
    if (doc.approved === true && !due) issues.push({ code: "missing_review_date", severity: "warning", message: "Approved document has no scheduled review date." });
    if (String(doc.content || "").trim().length < 20) issues.push({ code: "thin_content", severity: "warning", message: "Content is very short and may not answer guest questions completely." });
    const item = { id: doc.id || null, title: String(doc.title || "Untitled").slice(0, 160), category: String(doc.category || "general"), approved: doc.approved === true, issues };
    findings.push(...issues.map(issue => ({ ...issue, documentId: item.id, title: item.title })));
    return { doc, item, index };
  });

  const possibleConflicts = [];
  for (let i = 0; i < reviewed.length; i++) {
    for (let j = i + 1; j < reviewed.length; j++) {
      const a = reviewed[i], b = reviewed[j];
      if (String(a.doc.category || "general").toLowerCase() !== String(b.doc.category || "general").toLowerCase()) continue;
      const aw = new Set(words(a.doc.title)), bw = new Set(words(b.doc.title));
      const union = new Set([...aw, ...bw]);
      const overlap = union.size ? [...aw].filter(word => bw.has(word)).length / union.size : 0;
      if (overlap < 0.5) continue;
      const an = numbers(a.doc.content), bn = numbers(b.doc.content);
      if (an.length && bn.length && an.join("|") !== bn.join("|")) {
        possibleConflicts.push({
          code: "possible_conflict",
          severity: "review_required",
          documents: [{ id: a.item.id, title: a.item.title }, { id: b.item.id, title: b.item.title }],
          message: "Similar documents in the same category contain different numbers. A manager must confirm which value is current."
        });
      }
    }
  }
  return {
    documentCount: documents.length,
    blockingCount: findings.filter(x => x.severity === "blocking").length,
    warningCount: findings.filter(x => x.severity === "warning").length,
    possibleConflictCount: possibleConflicts.length,
    findings,
    possibleConflicts,
    note: "These are review flags, not proof that information is false. Veyra never resolves conflicting hotel facts automatically."
  };
}


function getGuestEligibleKnowledge(documents, today = new Date().toISOString().slice(0, 10)) {
  if (!Array.isArray(documents)) throw new Error("Knowledge documents must be a list.");
  const approvedAndCurrent = documents.filter(doc =>
    doc && doc.approved === true && (!dateOnly(doc.review_due_at) || dateOnly(doc.review_due_at) >= today)
  );
  const quality = analyzeKnowledgeQuality(approvedAndCurrent, today);
  const conflictIds = new Set(
    quality.possibleConflicts.flatMap(conflict => conflict.documents.map(document => document.id).filter(Boolean))
  );
  return approvedAndCurrent.filter(doc => !doc.id || !conflictIds.has(doc.id));
}

module.exports = { analyzeKnowledgeQuality, getGuestEligibleKnowledge };
