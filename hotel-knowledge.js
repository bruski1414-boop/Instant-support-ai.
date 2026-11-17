"use strict";

async function loadApprovedKnowledge(db, organizationId, today = new Date()) {
  const date = today instanceof Date ? today.toISOString().slice(0, 10) : String(today);
  return db.query(
    "SELECT title,category,content FROM knowledge_documents WHERE organization_id=$1 AND approved=true AND (review_due_at IS NULL OR review_due_at >= $2::date) ORDER BY updated_at DESC LIMIT 40",
    [organizationId, date],
  );
}

function buildApprovedKnowledgeContext(documents, maxChars = 26000) {
  if (!Array.isArray(documents)) throw new TypeError("Approved knowledge documents must be an array.");
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError("maxChars must be a positive integer.");

  const sections = [];
  let usedChars = 0;
  for (const document of documents) {
    if (!document || typeof document.title !== "string" ||
        typeof document.category !== "string" || typeof document.content !== "string") {
      continue;
    }
    const title = document.title.trim();
    const category = document.category.trim();
    const content = document.content.trim();
    if (!title || !category || !content) continue;

    const section = "[" + category + "] " + title + "\n" + content;
    const separator = sections.length ? "\n\n" : "";
    if (usedChars + separator.length + section.length > maxChars) break;
    sections.push(section);
    usedChars += separator.length + section.length;
  }
  return sections.join("\n\n");
}

module.exports = { loadApprovedKnowledge, buildApprovedKnowledgeContext };
