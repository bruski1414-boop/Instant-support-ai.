const test = require("node:test");
const assert = require("node:assert/strict");
const { configureRenderProxyTrust } = require("../render-proxy");

test("trusts exactly one proxy hop on a Render production deployment", () => {
  const calls = [];
  const app = { set: (...args) => calls.push(args) };
  assert.equal(configureRenderProxyTrust(app, { NODE_ENV: "production", RENDER_EXTERNAL_URL: "https://veyra.example.onrender.com" }), true);
  assert.deepEqual(calls, [["trust proxy", 1]]);
});

test("does not trust forwarded headers in local development", () => {
  const calls = [];
  const app = { set: (...args) => calls.push(args) };
  assert.equal(configureRenderProxyTrust(app, { NODE_ENV: "development", RENDER_EXTERNAL_URL: "https://veyra.example.onrender.com" }), false);
  assert.deepEqual(calls, []);
});

test("does not enable proxy trust in production without Render deployment metadata", () => {
  const calls = [];
  const app = { set: (...args) => calls.push(args) };
  assert.equal(configureRenderProxyTrust(app, { NODE_ENV: "production" }), false);
  assert.deepEqual(calls, []);
});
