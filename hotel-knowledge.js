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

function scoreDocument(questionTerms, document) {
  const titleTerms = new Set(terms(document.title));
  const categoryTerms = new Set(terms(document.category));
  const bodyTerms = new Set(terms(document.content));
  let score = 0;
  for (const term of questionTerms) {
    if (titleTerms.has(term)) score += 5;
    if (categoryTerms.has(term)) score += 2;
    if (bodyTerms.has(term)) score += 1;
  }
  const question = questionTerms.join(" ");
  const title = terms(document.title).join(" ");
  if (question && title && title.includes(question)) score += 8;
  return score;
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
    .map((doc, index) => ({ doc, index, score: scoreDocument(questionTerms, doc) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // Never place unrelated hotel documents in the model context. A no-match
  // result must lead to a safe "cannot verify" response, not a guess.
  const selected = ranked.filter(item => item.score > 0).slice(0, maxDocuments);
  const chosen = selected;
  const sections = [];
  let used = 0;
  const separator = "\n\n---\n\n";
  for (const { doc, score } of chosen) {
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
    used += separatorLength + clipped.length;
    if (clipped.length < section.length) break;
  }
  return {
    context: sections.join(separator),
    selectedCount: sections.length,
    matched: selected.length > 0,
    fallbackUsed: false,
    noRelevantKnowledge: selected.length === 0
  };
}

module.exports = { buildRelevantKnowledge, scoreDocument };
