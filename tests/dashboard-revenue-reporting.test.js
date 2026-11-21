const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "..", "dashboard.html"), "utf8");

test("revenue dashboard states its exact reporting and non-causal metric limits", () => {
  assert.match(html, /id="revenueWindowLabel"/);
  assert.match(html, /windowStart/);
  assert.match(html, /windowEnd/);
  assert.match(html, /Rolling 30 × 24-hour UTC window/);
  assert.match(html, /Influenced conversations: Not measured/);
  assert.match(html, /Estimated staff time saved: Not calculated/);
  assert.match(html, /financialVisibility/);
  assert.match(html, /Sale amounts and evidence references are restricted/);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.ok(scripts.length > 0, "dashboard must contain an inline application script");
  for (const source of scripts) assert.doesNotThrow(() => new vm.Script(source));
});
