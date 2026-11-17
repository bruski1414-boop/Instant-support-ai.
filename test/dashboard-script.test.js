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
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `dashboard must include #${id}`);
}


assert.match(html, /id=["']influencedConversations["'][^>]*>Not measured</, "influenced conversations must remain explicitly unmeasured without causal evidence");
assert.match(html, /id=["']staffTimeSavedEstimate["'][^>]*>Not calculated</, "staff time saved must remain uncalculated without a measured hotel baseline");
assert.match(html, /No causal definition or controlled comparison is configured/, "the dashboard must explain why influence is not reported");
assert.match(html, /Requires a hotel-measured handling-time baseline and validated deflection evidence/, "the dashboard must explain the evidence required for a time-saved estimate");
const inlineScript = scripts.map((match) => match[1]).join("\n");
assert.doesNotMatch(inlineScript, /\$\(["']influencedConversations["']\)\.textContent\s*=/, "linked revenue or conversation counts must not be reused as influenced-conversation data");
assert.doesNotMatch(inlineScript, /\$\(["']staffTimeSavedEstimate["']\)\.textContent\s*=/, "staff time saved must not be populated from an unverified proxy");
