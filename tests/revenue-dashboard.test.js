"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const html = readFileSync(path.join(__dirname, "..", "dashboard.html"), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
assert.ok(scripts.length > 0, "dashboard must contain its application script");
for (const [index, match] of scripts.entries()) {
  assert.doesNotThrow(
    () => new vm.Script(match[1], { filename: "revenue-dashboard-" + (index + 1) + ".js" }),
    "dashboard inline script " + (index + 1) + " must be valid JavaScript"
  );
}
assert.match(html, /Evidence-referenced conversions/);
assert.match(html, /Hotel-attested sale value/);
assert.match(html, /Not measured/);
assert.match(html, /Not calculated/);
assert.match(html, /not independently verified/i);
assert.match(html, /sale_occurred_at:saleRaw/);
assert.match(html, /minorUnitsFromMajor\(\$\("offerPrice"\)\.value,currency,true\)/);
assert.doesNotMatch(html, /sale_occurred_at:saleDate\.toISOString/);
assert.doesNotMatch(html, /Only staff-confirmed sales count as generated revenue/);
