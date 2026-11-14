import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];

assert.ok(scripts.length > 0, "dashboard must contain its application script");
for (const [index, match] of scripts.entries()) {
  assert.doesNotThrow(
    () => new vm.Script(match[1], { filename: `dashboard-inline-${index + 1}.js` }),
    `dashboard inline script ${index + 1} must be valid JavaScript`,
  );
}

for (const id of [
  "revenueAdjustmentForm",
  "adjustmentMessage",
  "revenueWindowLabel",
  "linkedConversationCount",
  "revenueWebhookCard",
  "revenueWebhookStatus",
  "revenueWebhookEndpoint",
  "rotateRevenueWebhook",
  "disableRevenueWebhook",
  "revenueWebhookSecret",
  "copyRevenueWebhookEndpoint",
  "copyRevenueWebhook",
  "staffReplyForm",
  "staffReplyMessage",
  "staffReplyStatus",
  "supportPerformance",
  "performanceConversations",
  "performanceAiOnly",
  "performanceStaff",
  "performanceHandoff",
  "performanceMedianReply",
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `dashboard must include #${id}`);
}
