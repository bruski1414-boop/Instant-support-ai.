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

test("dashboard inline JavaScript remains syntactically valid", () => {
  const scripts = [...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)];
  assert.ok(scripts.length > 0, "expected at least one inline script");
  for (const script of scripts) new vm.Script(script[1]);
});
