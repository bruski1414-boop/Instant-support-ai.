"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(require.resolve("../dashboard.html"), "utf8");

test("dashboard inline JavaScript parses successfully", () => {
  const match = html.match(/<script>([\\s\\S]*?)<\\/script>/i);
  assert.ok(match, "dashboard inline script should exist");
  assert.doesNotThrow(() => new vm.Script(match[1], { filename: "dashboard.html" }));
});

test("Mews dashboard exposes the secure connect, verify and owner disconnect workflow", () => {
  for (const id of [
    "mewsConnectionCard", "mewsConnectionStatus", "mewsConnectionForm",
    "mewsClientToken", "mewsAccessToken", "mewsPropertyReference",
    "mewsServiceId", "mewsTimezone", "saveMewsConnection",
    "verifyMewsConnection", "disconnectMewsConnection"
  ]) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(html, /type="password" maxlength="2048"/);
  assert.match(html, /api\\("\/api\/admin\/mews"/);
  assert.match(html, /api\\("\/api\/admin\/mews\/verify"/);
  assert.match(html, /api\\("\/api\/admin\/mews",\\{method:"DELETE"/);
  assert.match(html, /currentRole!=="owner"/);
  assert.match(html, /Saved tokens are never sent back to this page/);
});

test("Mews dashboard warns that only the demo environment and read-only availability are supported", () => {
  assert.match(html, /Only the official Mews demo environment is supported here/);
  assert.match(html, /Only read-only availability lookups are supported/);
});
