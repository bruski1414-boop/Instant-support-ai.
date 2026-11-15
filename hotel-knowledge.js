"use strict";

async function loadApprovedKnowledge(db, organizationId, today = new Date()) {
  const date = today instanceof Date ? today.toISOString().slice(0, 10) : String(today);
  return db.query(
    "SELECT title,category,content FROM knowledge_documents WHERE organization_id=$1 AND approved=true AND (review_due_at IS NULL OR review_due_at >= $2::date) ORDER BY updated_at DESC LIMIT 40",
    [organizationId, date],
  );
}

module.exports = { loadApprovedKnowledge };
