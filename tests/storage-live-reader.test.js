const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createTokenCipher } = require("../storage-security");
const { createStorageKnowledgeReader, parseSourceReference, encodeMicrosoftSourceReference } = require("../storage-live-reader");

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function fakeDatabase(encryptedTokens) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT encrypted_tokens")) {
        return { rowCount: 1, rows: [{ encrypted_tokens: encryptedTokens }] };
      }
      if (sql.startsWith("UPDATE storage_connections")) return { rowCount: 1, rows: [] };
      throw new Error("Unexpected database query: " + sql);
    },
  };
}

test("Google Drive live reader fetches current approved source content, not stored copy text", async () => {
  const key = crypto.randomBytes(32).toString("base64");
  const cipher = createTokenCipher(key);
  const db = fakeDatabase(cipher.encrypt({ access_token: "google-access", expires_at: Date.now() + 3600000 }));
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.includes("/drive/v3/files/google-file%2F1?")) {
      return response(JSON.stringify({
        id: "google-file/1",
        name: "Current breakfast policy",
        mimeType: "text/plain",
        modifiedTime: "2026-11-28T09:00:00.000Z",
        md5Checksum: "abc123",
      }), 200, { "content-type": "application/json" });
    }
    if (value.includes("alt=media")) return response("Breakfast is now served from 6:30 to 10:30.");
    throw new Error("Unexpected provider request: " + value);
  };
  const reader = createStorageKnowledgeReader({ db, fetchImpl, encryptionKey: key });
  const document = await reader.read({ organizationId: "hotel-alpha", sourceReference: "google:google-file/1" });
  assert.equal(document.content, "Breakfast is now served from 6:30 to 10:30.");
  assert.equal(document.title, "Current breakfast policy");
  assert.equal(document.modifiedAt, "2026-11-28T09:00:00.000Z");
  assert.equal(document.version, "abc123");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.headers.authorization === "Bearer google-access"));
  assert.deepEqual(db.calls[0].params, ["hotel-alpha", "google"]);
});

test("Microsoft live reader retains the selected SharePoint site context", async () => {
  const key = crypto.randomBytes(32).toString("base64");
  const cipher = createTokenCipher(key);
  const db = fakeDatabase(cipher.encrypt({ access_token: "microsoft-access", expires_at: Date.now() + 3600000 }));
  const calls = [];
  const sourceReference = encodeMicrosoftSourceReference("item-7", "site,tenant,web");
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.includes("/sites/site%2Ctenant%2Cweb/drive/items/item-7?")) {
      return response(JSON.stringify({
        id: "item-7",
        name: "Current pool hours",
        file: { mimeType: "text/plain" },
        lastModifiedDateTime: "2026-11-28T10:00:00.000Z",
        eTag: "etag-7",
      }), 200, { "content-type": "application/json" });
    }
    if (value.endsWith("/items/item-7/content")) return response("The pool closes at 8 PM.");
    throw new Error("Unexpected provider request: " + value);
  };
  const reader = createStorageKnowledgeReader({ db, fetchImpl, encryptionKey: key });
  const document = await reader.read({ organizationId: "hotel-beta", sourceReference });
  assert.equal(document.provider, "microsoft");
  assert.equal(document.content, "The pool closes at 8 PM.");
  assert.equal(document.modifiedAt, "2026-11-28T10:00:00.000Z");
  assert.equal(document.version, "etag-7");
  assert.ok(calls[0].url.includes("/sites/site%2Ctenant%2Cweb/"));
  assert.deepEqual(db.calls[0].params, ["hotel-beta", "microsoft"]);
});

test("live reader refreshes expired provider credentials and persists the encrypted rotation", async () => {
  const key = crypto.randomBytes(32).toString("base64");
  const cipher = createTokenCipher(key);
  const db = fakeDatabase(cipher.encrypt({
    access_token: "expired-access",
    refresh_token: "refresh-token",
    expires_at: Date.now() - 1000,
  }));
  const oldId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const oldSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value === "https://oauth2.googleapis.com/token") {
      return response(JSON.stringify({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 }));
    }
    if (value.includes("/drive/v3/files/file-refresh?")) {
      return response(JSON.stringify({ id: "file-refresh", name: "Refreshed policy", mimeType: "text/plain" }));
    }
    if (value.includes("alt=media")) return response("Fresh source contents.");
    throw new Error("Unexpected provider request: " + value);
  };
  try {
    const reader = createStorageKnowledgeReader({ db, fetchImpl, encryptionKey: key });
    const document = await reader.read({ organizationId: "hotel-delta", sourceReference: "google:file-refresh" });
    assert.equal(document.content, "Fresh source contents.");
    assert.ok(calls[0].options.body.toString().includes("refresh_token=refresh-token"));
    const update = db.calls.find(call => call.sql.startsWith("UPDATE storage_connections"));
    assert.ok(update, "rotated token must be persisted");
    assert.equal(update.params[1], "hotel-delta");
    assert.equal(update.params[2], "google");
    const rotated = cipher.decrypt(update.params[0]);
    assert.equal(rotated.access_token, "fresh-access");
    assert.equal(rotated.refresh_token, "rotated-refresh");
  } finally {
    if (oldId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = oldId;
    if (oldSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = oldSecret;
  }
});

test("source reference parsing rejects malformed and unsupported providers", () => {
  assert.deepEqual(parseSourceReference("google:drive-123"), {
    provider: "google",
    fileId: "drive-123",
    siteId: "",
  });
  assert.deepEqual(parseSourceReference("microsoft:legacy-item"), {
    provider: "microsoft",
    fileId: "legacy-item",
    siteId: "",
  });
  assert.deepEqual(parseSourceReference(encodeMicrosoftSourceReference("file-2", "site-2")), {
    provider: "microsoft",
    fileId: "file-2",
    siteId: "site-2",
  });
  assert.throws(() => parseSourceReference("dropbox:file-1"), /Unsupported/);
  assert.throws(() => parseSourceReference("microsoft:v1.not-json"), /Invalid/);
  assert.throws(() => encodeMicrosoftSourceReference("", ""), /Invalid/);
});

test("live reader fails closed when the connected source cannot be fetched", async () => {
  const key = crypto.randomBytes(32).toString("base64");
  const cipher = createTokenCipher(key);
  const db = fakeDatabase(cipher.encrypt({ access_token: "google-access", expires_at: Date.now() + 3600000 }));
  const reader = createStorageKnowledgeReader({
    db,
    encryptionKey: key,
    fetchImpl: async () => response(JSON.stringify({ error: { message: "not found" } }), 404, { "content-type": "application/json" }),
  });
  await assert.rejects(
    () => reader.read({ organizationId: "hotel-gamma", sourceReference: "google:missing-file" }),
    /unavailable or no longer an approved file type/
  );
});
