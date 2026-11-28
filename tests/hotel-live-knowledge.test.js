"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveLiveApprovedKnowledge } = require("../hotel-live-knowledge");

function makeDb({ rowCount = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount, rows: [] };
    },
  };
}

test("source-backed approved knowledge uses current provider content when its reviewed version matches", async () => {
  const db = makeDb();
  const readerCalls = [];
  const documents = [{
    id: "doc-1",
    title: "Breakfast hours",
    category: "dining",
    content: "Old imported copy.",
    source_reference: "google:file-1",
    source_version: "2026-11-28T09:00:00.000Z",
  }];
  const result = await resolveLiveApprovedKnowledge({
    db,
    organizationId: "hotel-alpha",
    documents,
    reader: {
      async read(args) {
        readerCalls.push(args);
        return { content: "Current breakfast hours.", version: "2026-11-28T09:00:00.000Z" };
      },
    },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "Current breakfast hours.");
  assert.equal(result[0].title, "Breakfast hours");
  assert.deepEqual(readerCalls, [{ organizationId: "hotel-alpha", sourceReference: "google:file-1" }]);
  assert.equal(db.calls.length, 0);
});

test("changed provider version invalidates approval and never returns the stale imported copy", async () => {
  const db = makeDb({ rowCount: 1 });
  const result = await resolveLiveApprovedKnowledge({
    db,
    organizationId: "hotel-alpha",
    documents: [{
      id: "doc-2",
      title: "Pool hours",
      category: "facilities",
      content: "Old pool hours.",
      source_reference: "microsoft:item-2",
      source_version: "etag-old",
    }],
    reader: { async read() { return { content: "New pool hours.", version: "etag-new" }; } },
  });
  assert.deepEqual(result, []);
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0].sql, /UPDATE knowledge_documents SET approved=false/);
  assert.match(db.calls[0].sql, /id=\$1 AND organization_id=\$2/);
  assert.deepEqual(db.calls[0].params, ["doc-2", "hotel-alpha", "microsoft:item-2", "etag-old"]);
  assert.match(db.calls[1].sql, /knowledge\.source_changed_requires_review/);
  assert.deepEqual(db.calls[1].params, ["hotel-alpha", "doc-2"]);
});

test("legacy source-backed copies without a recorded source version fail closed", async () => {
  const db = makeDb({ rowCount: 1 });
  let reads = 0;
  const result = await resolveLiveApprovedKnowledge({
    db,
    organizationId: "hotel-beta",
    documents: [{
      id: "doc-3",
      title: "Wi-Fi details",
      category: "general",
      content: "Imported copy.",
      source_reference: "google:file-3",
      source_version: "",
    }],
    reader: { async read() { reads += 1; return { content: "Provider says Wi-Fi is available.", version: "v3" }; } },
  });
  assert.equal(reads, 0, "unversioned legacy copies should be invalidated without a provider request");
  assert.deepEqual(result, []);
  assert.equal(db.calls[0].params[3], "");
});

test("unavailable provider source is excluded and never falls back to cached content", async () => {
  const db = makeDb();
  const result = await resolveLiveApprovedKnowledge({
    db,
    organizationId: "hotel-gamma",
    documents: [{
      id: "doc-4",
      title: "Restaurant menu",
      category: "dining",
      content: "Cached menu.",
      source_reference: "google:file-4",
      source_version: "v4",
    }],
    reader: { async read() { throw new Error("provider unavailable"); } },
  });
  assert.deepEqual(result, []);
  assert.equal(db.calls.length, 0);
});

test("live source checks use bounded concurrency", async () => {
  const db = makeDb();
  let active = 0;
  let maximum = 0;
  const documents = Array.from({ length: 12 }, (_, index) => ({
    id: "doc-" + index,
    title: "Policy " + index,
    category: "general",
    content: "Approved copy " + index,
    source_reference: "google:file-" + index,
    source_version: "v" + index,
  }));
  const result = await resolveLiveApprovedKnowledge({
    db,
    organizationId: "hotel-epsilon",
    documents,
    reader: {
      async read({ sourceReference }) {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        const index = Number(sourceReference.split("-").pop());
        return { content: "Current policy " + index, version: "v" + index };
      },
    },
  });
  assert.equal(result.length, 12);
  assert.equal(maximum, 4);
});

test("manually maintained approved knowledge does not require an external source reader", async () => {
  const db = makeDb();
  const document = {
    id: "doc-5",
    title: "Front desk contact",
    category: "general",
    content: "Call reception from the room phone.",
    source_reference: "",
    source_version: "",
  };
  const result = await resolveLiveApprovedKnowledge({
    db,
    organizationId: "hotel-delta",
    documents: [document],
    reader: null,
  });
  assert.deepEqual(result, [document]);
  assert.equal(db.calls.length, 0);
});
