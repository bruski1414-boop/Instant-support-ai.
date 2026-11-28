"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("hotel dashboard inline script parses without executing browser code", () => {
  const html = fs.readFileSync(require("node:path").join(__dirname, "..", "dashboard.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)];
  assert.ok(scripts.length > 0, "dashboard should contain its application script");
  const applicationScript = scripts[scripts.length - 1][1];
  assert.match(applicationScript, /async function loadHotelBookings\\(/);
  assert.match(applicationScript, /api\\("\\/api\\/admin\\/bookings/);
  assert.doesNotThrow(() => new vm.Script(applicationScript, { filename: "dashboard.html:inline-script" }));
});
