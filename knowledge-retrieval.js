"use strict";

const DEFAULT_MAX_CONTEXT_CHARS = 26000;
const QUESTION_FILLER_WORDS = new Set([
  "time", "served", "serves", "serve", "open", "opens", "opening", "close",
  "closes", "closing", "start", "starts", "started", "available", "availability",
  "use", "using", "area", "book", "booking", "tell", "let", "know", "do",
  "does", "did", "is", "are", "was", "were", "be", "been", "being", "please",
  "kindly", "need", "want", "like", "get", "getting", "have", "has", "had",
  "arrange", "arranged", "request", "requests", "work", "works", "exact", "tell", "group", "groups",
  "connect", "connecting", "connection", "access",
  "hotel", "hotels", "property", "properties", "offer", "offers", "offered",
  "provide", "provides", "provided", "hours", "hour", "begin", "begins",
  "end", "ends", "much", "many", "any", "some", "anywhere", "around",
]);
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
  swim: ["pool", "swimming"],
  wifi: ["wireless"],
  wireless: ["wifi"],
  checkout: ["departure", "check-out"],
  "check-out": ["checkout", "departure"],
  departure: ["checkout", "check-out"],
  checkin: ["arrival", "check-in"],
  "check-in": ["checkin", "arrival"],
  arrival: ["checkin", "check-in"],
  taxi: ["car", "transport"],
  transfer: ["airport", "transport"],
  pickup: ["airport", "transfer"],
  gym: ["fitness", "workout"],
  fitness: ["gym", "workout"],
  workout: ["gym", "fitness"],
  spa: ["massage", "wellness"],
  massage: ["spa", "wellness"],
  wellness: ["spa", "massage"],
  restaurant: ["dining"],
  dining: ["restaurant"],
  food: ["dining", "restaurant"],
  age: ["aged", "ages"],
  ages: ["age", "aged"],
  aged: ["age", "ages"],
  treatment: ["treatments"],
  treatments: ["treatment"],
  price: ["cost"],
  cost: ["price"],
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

function normalizeGuestQuery(query) {
  return String(query || "").toLowerCase()
    .replace(/\bmorning meal\b/g, "breakfast")
    .replace(/\bmidday meal\b/g, "lunch")
    .replace(/\bevening meal\b/g, "dinner")
    .replace(/\bwireless internet\b/g, "wifi")
    .replace(/\bwi[ -]?fi\b/g, "wifi")
    .replace(/\bswimming pool\b/g, "pool")
    .replace(/\bwork out\b/g, "gym")
    .replace(/\bcheck[ -]?out\b/g, "checkout")
    .replace(/\bcheck[ -]?in\b/g, "checkin");
}

function getMeaningfulQueryTokens(query) {
  const normalized = normalizeGuestQuery(query);
  const tokens = tokenize(normalized)
    .filter((token) => !QUESTION_FILLER_WORDS.has(token));

  // "How much for breakfast?" expresses a price request even though
  // "much" itself is a filler word. Preserve that missing intent explicitly.
  if (/\bhow much\b/.test(normalized) && !/\b(time|long|far|many)\b/.test(normalized)) {
    tokens.push("price", "cost");
  }
  return [...new Set(tokens)];
}

function hasRelevantKnowledgeMatch(documents, query) {
  if (!Array.isArray(documents) || documents.length === 0) return false;
  const queryTokens = getMeaningfulQueryTokens(query);
  if (!queryTokens.length) return false;

  // Require one approved document to support every meaningful query term.
  // Combining tokens across unrelated documents can make an unsupported
  // detail (for example, a breakfast price) appear supported by coincidence.
  return documents.some((doc) => {
    if (!doc || typeof doc !== "object") return false;
    const documentTokens = new Set(
      tokenize(normalizeGuestQuery([doc.title, doc.category, doc.content].join(" "))),
    );
    return queryTokens.every((token) => {
      const accepted = [token, ...tokenize(SYNONYMS[token] || [])];
      return accepted.some((candidate) => documentTokens.has(candidate));
    });
  });
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

function buildEvidenceKnowledgeContext(documents, query) {
  if (!Array.isArray(documents) || documents.length === 0) return "";
  const queryTokens = expandQueryTokens(getMeaningfulQueryTokens(query), query);
  if (queryTokens.length === 0) return "";

  return documents
    .filter((doc) =>
      doc &&
      typeof doc.title === "string" &&
      typeof doc.content === "string" &&
      doc.title.trim() &&
      doc.content.trim() &&
      scoreDocument(doc, queryTokens) > 0
    )
    .map((doc) => "[" + String(doc.category || "general") + "] " + doc.title.trim() + "\\n" + doc.content.trim())
    .join("\\n\\n");
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

  const queryTokens = expandQueryTokens(getMeaningfulQueryTokens(query), query);
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
  normalizeGuestQuery,
  hasRelevantKnowledgeMatch,
  buildEvidenceKnowledgeContext,
  buildRelevantKnowledgeContext,
};
