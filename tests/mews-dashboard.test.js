"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(require.resolve("../dashboard.html"), "utf8");

test("dashboard inline JavaScript parses successfully", () => {
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "dashboard inline script should exist");
  assert.doesNotThrow(() => new vm.Script(html.slice(start + 8, end), { filename: "dashboard.html" }));
});

test("Mews dashboard exposes the secure connect, verify and owner disconnect workflow", () => {
  for (const id of [
    "mewsConnectionCard", "mewsConnectionStatus", "mewsConnectionForm",
    "mewsClientToken", "mewsAccessToken", "mewsPropertyReference",
    "mewsServiceId", "mewsTimezone", "saveMewsConnection",
    "verifyMewsConnection", "disconnectMewsConnection"
  ]) assert.ok(html.includes('id="' + id + '"'), "missing dashboard element: " + id);
  assert.ok(html.includes('type="password" maxlength="2048"'));
  assert.ok(html.includes('api("/api/admin/mews"'));
  assert.ok(html.includes('api("/api/admin/mews/verify"'));
  assert.ok(html.includes('api("/api/admin/mews",{method:"DELETE"'));
  assert.ok(html.includes('currentRole!=="owner"'));
  assert.ok(html.includes("Saved tokens are never sent back to this page"));
});

test("Mews dashboard warns that only the demo environment and read-only availability are supported", () => {
  assert.ok(html.includes("Only the official Mews demo environment is supported here"));
  assert.ok(html.includes("Only read-only availability lookups are supported"));
});
