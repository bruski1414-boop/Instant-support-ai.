"use strict";

async function resolveLiveApprovedKnowledge({ db, organizationId, documents, reader }) {
  if (!db || typeof db.query !== "function") throw new Error("A database client is required.");
  if (typeof organizationId !== "string" || !organizationId) throw new Error("Hotel context is required.");
  if (!Array.isArray(documents)) throw new Error("Approved hotel documents are required.");
  const resolved = new Array(documents.length);
  let nextIndex = 0;

  async function invalidate(document, expectedVersion) {
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
  }

  async function resolveOne(document, index) {
    if (!document.source_reference) {
      resolved[index] = document;
      return;
    }

    const expectedVersion = typeof document.source_version === "string" ? document.source_version : "";
    if (!expectedVersion) {
      await invalidate(document, expectedVersion);
      return;
    }

    let live;
    try {
      if (!reader || typeof reader.read !== "function") throw new Error("Live storage reader is unavailable.");
      live = await reader.read({ organizationId, sourceReference: document.source_reference });
    } catch {
      // Never fall back to an imported copy when its connected source cannot be checked.
      return;
    }

    if (!live.version || live.version !== expectedVersion) {
      await invalidate(document, expectedVersion);
      return;
    }

    // Use current provider content, but retain the manager-reviewed title/category.
    resolved[index] = { ...document, content: live.content };
  }

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= documents.length) return;
      await resolveOne(documents[index], index);
    }
  }

  const workerCount = Math.min(4, documents.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return resolved.filter(Boolean);
}

module.exports = { resolveLiveApprovedKnowledge };
