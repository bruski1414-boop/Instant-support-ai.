"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(require.resolve("../demo.html"), "utf8");

test("interactive demo page inline JavaScript parses", () => {
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotThrow(() => new vm.Script(html.slice(start + 8, end), { filename: "demo.html" }));
});

test("demo page clearly labels simulated inventory, metrics and staff handoffs", () => {
  assert.match(html, /DEMO ONLY/);
  assert.match(html, /fictional hotel/);
  assert.match(html, /simulated inventory/);
  assert.match(html, /no real hotel employee has been contacted|no real notification was sent/i);
  assert.match(html, /hotel-reported booking value/i);
  assert.match(html, /Veyra-linked revenue evidence/i);
});

test("demo page uses the isolated demo API and renders guest text safely", () => {
  assert.match(html, /fetch\("\/api\/demo\/chat"/);
  assert.match(html, /fetch\("\/api\/demo\/metrics"/);
  assert.match(html, /bubble\.textContent=text/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
});
