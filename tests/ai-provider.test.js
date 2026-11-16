"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateStructuredGuestAnswer, SAFE_FALLBACK, AI_REQUEST_TIMEOUT_MS } = require("../ai-provider");

function clientReturning(content) {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } } };
}


test("guest AI requests use a bounded timeout and do not add hidden provider retries", async () => {
  let options;
  const client = { chat: { completions: { create: async (_params, requestOptions) => {
    options = requestOptions;
    return { choices: [{ message: { content: JSON.stringify({ reply: "Welcome.", needsHuman: false, handoffReason: "" }) } }] };
  } } } };
  const answer = await generateStructuredGuestAnswer({ client, model: "test-model", messages: [] });
  assert.equal(answer.reply, "Welcome.");
  assert.equal(options.timeout, AI_REQUEST_TIMEOUT_MS);
  assert.equal(options.maxRetries, 0);
  assert.equal(AI_REQUEST_TIMEOUT_MS, 15000);
});

test("returns a structurally valid AI guest answer", async () => {
  const answer = await generateStructuredGuestAnswer({
    client: clientReturning(JSON.stringify({ reply: "Breakfast is served from 7 to 10.", needsHuman: false, handoffReason: "" })),
    model: "test-model",
    messages: []
  });
  assert.deepEqual(answer, { reply: "Breakfast is served from 7 to 10.", needsHuman: false, handoffReason: "" });
});

test("converts provider outages into a staff handoff instead of a failed guest request", async () => {
  const client = { chat: { completions: { create: async () => { throw new Error("private provider detail"); } } } };
  const answer = await generateStructuredGuestAnswer({ client, model: "test-model", messages: [] });
  assert.deepEqual(answer, SAFE_FALLBACK);
  assert.equal(answer.needsHuman, true);
  assert.doesNotMatch(JSON.stringify(answer), /private provider detail/);
});

test("converts malformed JSON into a staff handoff", async () => {
  const answer = await generateStructuredGuestAnswer({ client: clientReturning("not-json"), model: "test-model", messages: [] });
  assert.equal(answer.needsHuman, true);
  assert.match(answer.handoffReason, /invalid JSON/);
});

test("converts invalid structured responses into a staff handoff", async () => {
  const answer = await generateStructuredGuestAnswer({
    client: clientReturning(JSON.stringify({ reply: "Hello", needsHuman: "no", handoffReason: "" })),
    model: "test-model",
    messages: []
  });
  assert.equal(answer.needsHuman, true);
  assert.match(answer.handoffReason, /invalid response format/);
});
