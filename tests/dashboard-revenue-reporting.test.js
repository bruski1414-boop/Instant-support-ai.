const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "..", "dashboard.html"), "utf8");

test("revenue dashboard uses exact UTC windows and does not claim causation or unmeasured ROI", () => {
  assert.match(html, /Rolling 30 × 24-hour UTC window/);
  assert.match(html, /windowStart/);
  assert.match(html, /windowEnd/);
  assert.match(html, /Influenced conversations: Not measured/);
  assert.match(html, /Estimated staff time saved: Not calculated/);
  assert.match(html, /legacy conversion records without evidence are excluded from revenue totals/i);
  assert.match(html, /financialVisibility/);
  assert.match(html, /Only an owner or admin can attest a completed sale/);
  assert.match(html, /Evidence history/);
});

test("revenue dashboard scripts parse and currency formatting uses ISO precision", () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.ok(scripts.length > 0);
  for (const source of scripts) assert.doesNotThrow(() => new vm.Script(source));
  assert.match(html, /BigInt\(String\(amount\|\|0\)\)/);
  assert.match(html, /maximumFractionDigits/);
});
