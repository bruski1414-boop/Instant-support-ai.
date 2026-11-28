"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { persistImportedKnowledge } = require("../storage-integrations");

const actor = { organization_id: "hotel-alpha", user_id: "owner-alpha" };

function makeDb({ existing = null, failOnAudit = false } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.startsWith("SELECT * FROM knowledge_documents")) {
        return { rowCount: existing ? 1 : 0, rows: existing ? [existing] : [] };
      }
      if (sql.startsWith("UPDATE knowledge_documents")) {
        return { rowCount: 1, rows: [{
          id: existing.id,
          title: params[0],
          approved: false,
          source_reference: existing.source_reference,
          updated_at: "2026-11-28T00:00:00.000Z",
        }] };
      }
      if (sql.startsWith("INSERT INTO knowledge_documents")) {
        return { rowCount: 1, rows: [{
          id: "new-document",
          title: params[1],
          approved: false,
          source_reference: params[3],
          updated_at: "2026-11-28T00:00:00.000Z",
        }] };
      }
      if (sql.startsWith("INSERT INTO audit_logs") && failOnAudit) {
        throw new Error("simulated audit write failure");
      }
      return { rowCount: 1, rows: [] };
    },
    release() { released = true; },
  };
  return {
    calls,
    get released() { return released; },
    async connect() { return client; },
  };
}

test("new storage imports commit document, version history, and audit together", async () => {
  const db = makeDb();
  const document = await persistImportedKnowledge({
    db,
    actor,
    provider: "google",
    fileId: "drive-file-1",
    name: "Hotel breakfast",
    content: "Breakfast is served from 7 to 10.",
  });

  assert.equal(document.id, "new-document");
  assert.equal(document.approved, false);
  const statements = db.calls.map(call => call.sql);
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements[1], "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))");
  const importLock = db.calls[1];
  assert.deepEqual(importLock.params, [actor.organization_id, "google:drive-file-1"]);
  assert.ok(statements.some(sql => sql.startsWith("INSERT INTO knowledge_documents")));
  assert.ok(statements.some(sql => sql.startsWith("INSERT INTO knowledge_document_versions")));
  assert.ok(statements.some(sql => sql.startsWith("INSERT INTO audit_logs")));
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(db.released, true);
  const scopedInsert = db.calls.find(call => call.sql.startsWith("INSERT INTO knowledge_documents"));
  assert.equal(scopedInsert.params[0], actor.organization_id);
});

test("failed storage refresh rolls back document changes, versions, and audit as one transaction", async () => {
  const previous = {
    id: "existing-document",
    title: "Old breakfast details",
    category: "imported_document",
    content: "Old content",
    approved: true,
    source_reference: "google:drive-file-2",
    review_due_at: null,
    reviewed_at: "2026-11-01",
  };
  const db = makeDb({ existing: previous, failOnAudit: true });

  await assert.rejects(
    () => persistImportedKnowledge({
      db,
      actor,
      provider: "google",
      fileId: "drive-file-2",
      name: "Updated breakfast details",
      content: "Updated content",
    }),
    /simulated audit write failure/,
  );

  const statements = db.calls.map(call => call.sql);
  assert.equal(statements[0], "BEGIN");
  assert.ok(statements.some(sql => sql.startsWith("INSERT INTO knowledge_document_versions")));
  assert.ok(statements.some(sql => sql.startsWith("UPDATE knowledge_documents")));
  assert.ok(statements.some(sql => sql.startsWith("INSERT INTO audit_logs")));
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(db.released, true);
});
