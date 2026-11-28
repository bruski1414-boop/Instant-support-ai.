"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("hotel dashboard inline script parses without executing browser code", () => {
  const html = fs.readFileSync(require("node:path").join(__dirname, "..", "dashboard.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, "dashboard should contain its application script");
  const applicationScript = scripts[scripts.length - 1][1];
  assert.match(applicationScript, /async function loadHotelBookings\(/);
  assert.match(applicationScript, /api\("\/api\/admin\/bookings/);
  assert.match(applicationScript, /bookingOffset\+=50/);
  assert.match(applicationScript, /bookingPrevious/);
  assert.match(html, /id="panel-integrations"/);
  assert.match(html, /data-panel="integrations"/);
  assert.match(applicationScript, /api\("\/api\/admin\/payment-provider-capabilities"\)/);
  assert.match(applicationScript, /api\("\/api\/admin\/payment-connections"\)/);
  assert.match(applicationScript, /No supported payment providers yet/);
  assert.match(html, /id="pmsCapabilityCards"/);
  assert.match(html, /id="pmsConnectionsList"/);
  assert.match(html, /id="pmsAdapterTestsList"/);
  assert.match(applicationScript, /api\("\/api\/admin\/integrations\/pms"\)/);
  assert.match(applicationScript, /Production PMS ready/);
  assert.match(applicationScript, /sandbox only/);
  assert.doesNotThrow(() => new vm.Script(applicationScript, { filename: "dashboard.html:inline-script" }));
});
