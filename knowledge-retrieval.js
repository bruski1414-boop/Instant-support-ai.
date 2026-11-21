"use strict";

const DEFAULT_MAX_CONTEXT_CHARS = 26000;
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "can", "could", "does",
  "for", "from", "have", "help", "how", "into", "is", "its", "just", "may",
  "might", "more", "most", "please", "should", "some", "that", "the", "their",
  "them", "there", "these", "they", "this", "those", "was", "what", "when",
  "where", "which", "who", "will", "with", "would", "you", "your",
]);

const SYNONYMS = {
  breakfast: ["morning meal"],
  "morning meal": ["breakfast"],
  morning: ["breakfast"],
  lunch: ["midday meal"],
  dinner: ["evening meal"],
  "evening meal": ["dinner"],
  evening: ["dinner"],
  pool: ["swimming", "swimming pool"],
  swimming: ["pool"],
  wifi: ["wireless", "internet"],
  wireless: ["wifi", "internet"],
  internet: ["wifi", "wireless"],
  checkout: ["departure", "check-out"],
  "check-out": ["checkout", "departure"],
  departure: ["checkout", "check-out"],
  checkin: ["arrival", "check-in"],
  "check-in": ["checkin", "arrival"],
  arrival: ["checkin", "check-in"],
  taxi: ["car", "transport"],
  transfer: ["airport", "transport"],
  gym: ["fitness", "workout"],
  fitness: ["gym"],
};

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((token) => !STOP_WORDS.has(token)) || [];
}

function expandQueryTokens(tokens, queryText = "") {
  const expanded = new Set(tokens);
  const normalizedQuery = String(queryText).toLowerCase();
  for (const [phrase, synonyms] of Object.entries(SYNONYMS)) {
    if (phrase.includes(" ") && normalizedQuery.includes(phrase)) {
      for (const synonym of synonyms) {
        for (const synonymToken of tokenize(synonym)) expanded.add(synonymToken);
      }
    }
  }
  for (const token of tokens) {
    for (const synonym of SYNONYMS[token] || []) {
      for (const synonymToken of tokenize(synonym)) expanded.add(synonymToken);
    }
  }
  return [...expanded];
}

function scoreDocument(document, queryTokens) {
  const titleTokens = new Set(tokenize(document.title));
  const categoryTokens = new Set(tokenize(document.category));
  const contentTokens = new Set(tokenize(document.content));
  let score = 0;

  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += 4;
    else if (categoryTokens.has(token)) score += 2;
    else if (contentTokens.has(token)) score += 1;
  }
  return score;
}

function buildRelevantKnowledgeContext(
  documents,
  query,
  { maxChars = DEFAULT_MAX_CONTEXT_CHARS } = {},
) {
  if (!Array.isArray(documents) || documents.length === 0) return "";
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new TypeError("maxChars must be a positive integer.");
  }

  const normalized = documents
    .filter((doc) =>
      doc &&
      typeof doc.title === "string" &&
      typeof doc.content === "string" &&
      doc.title.trim() &&
      doc.content.trim()
    )
    .map((doc, index) => ({
      index,
      source: doc,
      text: "[" + String(doc.category || "general") + "] " + doc.title.trim() + "\n" + doc.content.trim(),
    }));

  const fullContext = normalized.map((doc) => doc.text).join("\n\n");
  if (fullContext.length <= maxChars) return fullContext;

  const queryTokens = expandQueryTokens([...new Set(tokenize(query))], query);
  if (queryTokens.length === 0) return "";

  const ranked = normalized
    .map((doc) => ({
      ...doc,
      score: scoreDocument(doc.source, queryTokens),
    }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const selected = [];
  let usedChars = 0;
  for (const doc of ranked) {
    const extraChars = doc.text.length + (selected.length ? 2 : 0);
    if (usedChars + extraChars > maxChars) continue;
    selected.push(doc);
    usedChars += extraChars;
  }

  return selected
    .sort((a, b) => a.index - b.index)
    .map((doc) => doc.text)
    .join("\n\n");
}

module.exports = {
  DEFAULT_MAX_CONTEXT_CHARS,
  tokenize,
  expandQueryTokens,
  scoreDocument,
  buildRelevantKnowledgeContext,
};
