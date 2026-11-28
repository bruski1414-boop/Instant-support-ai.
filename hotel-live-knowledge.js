"use strict";

async function resolveLiveApprovedKnowledge({ db, organizationId, documents, reader }) {
  if (!db || typeof db.query !== "function") throw new Error("A database client is required.");
  if (typeof organizationId !== "string" || !organizationId) throw new Error("Hotel context is required.");
  if (!Array.isArray(documents)) throw new Error("Approved hotel documents are required.");
  const resolved = [];

  for (const document of documents) {
    if (!document.source_reference) {
      resolved.push(document);
      continue;
    }

    let live;
    try {
      if (!reader || typeof reader.read !== "function") throw new Error("Live storage reader is unavailable.");
      live = await reader.read({ organizationId, sourceReference: document.source_reference });
    } catch {
      // Never fall back to an imported copy when its connected source cannot be checked.
      continue;
    }

    const expectedVersion = typeof document.source_version === "string" ? document.source_version : "";
    if (!expectedVersion || !live.version || live.version !== expectedVersion) {
      const updated = await db.query(
        "UPDATE knowledge_documents SET approved=false,reviewed_at=NULL,updated_at=now() WHERE id=$1 AND organization_id=$2 AND source_reference=$3 AND source_version=$4 AND approved=true",
        [document.id, organizationId, document.source_reference, expectedVersion]
      );
      if (updated.rowCount) {
        await db.query(
          "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id) VALUES($1,NULL,'knowledge.source_changed_requires_review','knowledge_document',$2)",
          [organizationId, document.id]
        );
      }
      continue;
    }

    // Use current provider content, but retain the manager-reviewed title/category.
    resolved.push({ ...document, content: live.content });
  }

  return resolved;
}

module.exports = { resolveLiveApprovedKnowledge };
