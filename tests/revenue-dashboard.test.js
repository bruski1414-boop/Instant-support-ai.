import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
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
assert.doesNotMatch(html, /Only staff-confirmed sales count as generated revenue/);
