"use strict";

const STOP_WORDS = new Set([
  "a","an","and","are","as","at","be","by","can","could","do","does","for","from",
  "how","i","in","is","it","me","my","of","on","or","our","please","the","there",
  "to","we","what","when","where","which","who","why","with","you","your"
]);

function terms(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z0-9]{2,}/g) || [];
}

function scoreDocumentDetails(questionTerms, document) {
  const titleTerms = new Set(terms(document.title));
  const categoryTerms = new Set(terms(document.category));
  const bodyTerms = new Set(terms(document.content));
  let score = 0;
  let matchedTerms = 0;
  for (const term of questionTerms) {
    let matched = false;
    if (titleTerms.has(term)) { score += 5; matched = true; }
    if (categoryTerms.has(term)) { score += 2; matched = true; }
    if (bodyTerms.has(term)) { score += 1; matched = true; }
    if (matched) matchedTerms += 1;
  }
  const coverage = questionTerms.length ? matchedTerms / questionTerms.length : 0;
  const question = questionTerms.join(" ");
  const title = terms(document.title).join(" ");
  if (question && title && title.includes(question)) score += 8;
  return { score, coverage, matchedTerms };
}

function scoreDocument(questionTerms, document) {
  return scoreDocumentDetails(questionTerms, document).score;
}

function buildRelevantKnowledge(question, documents, options = {}) {
  if (typeof question !== "string" || !question.trim()) {
    throw new Error("A guest question is required for knowledge retrieval.");
  }
  if (!Array.isArray(documents)) throw new Error("Approved knowledge documents must be a list.");
  const maxDocuments = Number.isInteger(options.maxDocuments) ? options.maxDocuments : 10;
  const maxCharacters = Number.isInteger(options.maxCharacters) ? options.maxCharacters : 24000;
  if (maxDocuments < 1 || maxDocuments > 40 || maxCharacters < 1000 || maxCharacters > 30000) {
    throw new Error("Knowledge retrieval limits are outside the permitted range.");
  }

  const questionTerms = [...new Set(terms(question).filter(term => !STOP_WORDS.has(term)))];
  const ranked = documents
    .filter(doc => doc && typeof doc.title === "string" && typeof doc.content === "string")
    .map((doc, index) => ({ doc, index, ...scoreDocumentDetails(questionTerms, doc) }))
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.index - b.index);

  // Keep a conservative relevance threshold: one weak keyword match is not
  // enough when a guest asks a multi-part question.
  const minCoverage = questionTerms.length >= 3 ? 0.34 : 0.5;
  const selected = ranked
    .filter(item => item.score > 0 && item.coverage >= minCoverage)
    .slice(0, maxDocuments);
  const sections = [];
  const sources = [];
  let used = 0;
  const separator = "\n\n---\n\n";
  for (const { doc, score, coverage } of selected) {
    const reviewed = doc.reviewed_at ? new Date(doc.reviewed_at).toISOString().slice(0, 10) : "not recorded";
    const reviewDue = doc.review_due_at ? String(doc.review_due_at).slice(0, 10) : "no scheduled review";
    const source = doc.source_reference ? String(doc.source_reference).slice(0, 500) : "not recorded";
    const section = "[" + String(doc.category || "general") + "] " + doc.title +
      "\nRelevance score: " + score +
      "\nSource reference: " + source +
      "\nLast manager review: " + reviewed +
      "\nReview due: " + reviewDue +
      "\nApproved content:\n" + doc.content;
    const separatorLength = sections.length ? separator.length : 0;
    const remaining = maxCharacters - used - separatorLength;
    if (remaining <= 0) break;
    const clipped = section.slice(0, remaining);
    sections.push(clipped);
    sources.push({
      title: String(doc.title).slice(0, 160),
      category: String(doc.category || "general").slice(0, 60),
      sourceReference: source,
      reviewedAt: doc.reviewed_at || null,
      reviewDueAt: doc.review_due_at || null,
      relevanceScore: score,
      termCoverage: Number(coverage.toFixed(2))
    });
    used += separatorLength + clipped.length;
    if (clipped.length < section.length) break;
  }
  return {
    context: sections.join(separator),
    sources,
    selectedCount: sections.length,
    matched: sections.length > 0,
    fallbackUsed: false,
    noRelevantKnowledge: sections.length === 0
  };
}

module.exports = { buildRelevantKnowledge, scoreDocument };
