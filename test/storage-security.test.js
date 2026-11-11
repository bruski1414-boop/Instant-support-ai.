const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createTokenCipher, readTextLimited } = require("../storage-security");

test("storage tokens encrypt and decrypt without exposing plaintext", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const cipher = createTokenCipher(key);
  const secret = { access_token: "synthetic-access-token", refresh_token: "synthetic-refresh-token" };
  const encrypted = cipher.encrypt(secret);

  assert.equal(cipher.configured, true);
  assert.deepEqual(cipher.decrypt(encrypted), secret);
  assert.equal(encrypted.includes(secret.access_token), false);
  assert.equal(encrypted.includes(secret.refresh_token), false);
});

test("storage token encryption uses a fresh nonce for each encryption", () => {
  const cipher = createTokenCipher(Buffer.alloc(32, 8).toString("base64"));
  const first = cipher.encrypt({ token: "same-value" });
  const second = cipher.encrypt({ token: "same-value" });

  assert.notEqual(first, second);
  assert.deepEqual(cipher.decrypt(first), { token: "same-value" });
  assert.deepEqual(cipher.decrypt(second), { token: "same-value" });
});

test("tampered encrypted storage tokens are rejected", () => {
  const cipher = createTokenCipher(Buffer.alloc(32, 9).toString("base64"));
  const encrypted = cipher.encrypt({ token: "synthetic-secret" });
  const parts = encrypted.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);

  assert.throws(() => cipher.decrypt(parts.join(".")));
});

test("invalid encryption keys cannot encrypt or decrypt", () => {
  const cipher = createTokenCipher("not-a-valid-32-byte-key");

  assert.equal(cipher.configured, false);
  assert.throws(() => cipher.encrypt({ token: "secret" }), /32-byte key/);
  assert.throws(() => cipher.decrypt("a.b.c"), /key is unavailable/);
});

test("document reader accepts content exactly at its byte limit", async () => {
  const response = new Response(Readable.toWeb(Readable.from([Buffer.from("1234")])), {
    status: 200,
    headers: { "content-length": "4" },
  });

  assert.equal(await readTextLimited(response, 4), "1234");
});

test("document reader rejects a declared oversized download before reading", async () => {
  let read = false;
  const body = new ReadableStream({
    pull(controller) {
      read = true;
      controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      controller.close();
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { "content-length": "5" },
  });

  await assert.rejects(readTextLimited(response, 4), /larger than the 12 KB/);
  assert.equal(read, false);
});

test("document reader rejects streamed data that exceeds its byte limit", async () => {
  const response = new Response(Readable.toWeb(Readable.from([
    Buffer.from("123"), Buffer.from("456"),
  ])), { status: 200 });

  await assert.rejects(readTextLimited(response, 5), /larger than the 12 KB/);
});

test("document reader rejects failed provider responses", async () => {
  const response = new Response("provider error", { status: 503 });

  await assert.rejects(readTextLimited(response), /Could not download/);
});

test("Microsoft download URLs must use approved HTTPS provider hosts", () => {
  const { validateMicrosoftDownloadUrl } = require("../storage-security");
  for (const url of [
    "http://files.sharepoint.com/document.txt",
    "https://localhost/document.txt",
    "https://127.0.0.1/document.txt",
    "https://sharepoint.com.attacker.example/document.txt",
    "https://user:pass@files.sharepoint.com/document.txt",
    "https://files.sharepoint.com:8443/document.txt",
    "https://attacker.example/document.txt",
  ]) {
    assert.throws(() => validateMicrosoftDownloadUrl(url), /approved download hosts/);
  }
  assert.match(validateMicrosoftDownloadUrl("https://tenant.sharepoint.com/document.txt"), /^https:\/\//);
  assert.match(validateMicrosoftDownloadUrl("https://tenant-my.sharepointonline.com/document.txt"), /^https:\/\//);
  assert.match(validateMicrosoftDownloadUrl("https://public.1drv.com/document.txt"), /^https:\/\//);
});

test("Microsoft download redirect chains are validated at every hop", async (t) => {
  const { mock } = require("node:test");
  const { fetchMicrosoftDownload } = require("../storage-security");
  const calls = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), redirect: options.redirect });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } });
    return new Response("unexpected");
  });
  t.after(() => fetchMock.mock.restore());

  await assert.rejects(
    fetchMicrosoftDownload("https://tenant.sharepoint.com/document.txt"),
    /approved download hosts/
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "manual");
});

test("Microsoft download helper follows a bounded approved redirect", async (t) => {
  const { mock } = require("node:test");
  const { fetchMicrosoftDownload } = require("../storage-security");
  const calls = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), redirect: options.redirect });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://cdn.1drv.com/file.txt" } });
    return new Response("safe document", { status: 200 });
  });
  t.after(() => fetchMock.mock.restore());

  const response = await fetchMicrosoftDownload("https://tenant.sharepoint.com/document.txt");
  assert.equal(await response.text(), "safe document");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.redirect === "manual"));
});
