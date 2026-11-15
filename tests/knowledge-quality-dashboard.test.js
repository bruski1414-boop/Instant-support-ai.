"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(require("node:path").join(__dirname, "..", "dashboard.html"), "utf8");

test("hotel dashboard includes a knowledge quality review panel", () => {
  assert.match(html, /id="knowledgeQuality"/);
  assert.match(html, /Knowledge quality review/);
  assert.match(html, /Possible conflicting information/);
  assert.match(html, /Manager review required/);
});

test("dashboard renders API quality findings and possible conflicts safely", () => {
  assert.match(html, /const quality=d\.quality/);
  assert.match(html, /quality\.findings/);
  assert.match(html, /quality\.possibleConflicts/);
  assert.match(html, /safe\(item\.message\)/);
  assert.match(html, /safe\(quality\.note/);
});


test("hotel onboarding dashboard displays all deployment safety gates", () => {
  assert.match(html, /id="readinessList"/);
  for (const label of [
    "Guest data storage enabled",
    "Durable backups and restore",
    "Tenant isolation tests",
    "Provider OAuth verification",
    "Staff handoff and fallback test",
    "Pilot release approval",
  ]) {
    assert.ok(html.includes("readinessList"), "expected the readiness list container");
  }
  assert.match(html, /o\.checks\.map/);
  assert.match(html, /safe\(x\.label\)/);
  assert.match(html, /safe\(x\.detail\)/);
  assert.match(html, /All checks passed/);
  assert.match(html, /Needs attention/);
});

test("dashboard inline JavaScript remains syntactically valid", () => {
  const start = html.lastIndexOf("<script>");
  const end = html.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "expected an inline script block");
  new vm.Script(html.slice(start + "<script>".length, end));
});
