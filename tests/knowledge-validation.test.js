"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidDateOnly, isOptionalBoolean } = require("../knowledge-validation");

test("knowledge review dates accept real calendar dates", () => {
  assert.equal(isValidDateOnly("2026-11-14"), true);
  assert.equal(isValidDateOnly("2024-02-29"), true);
  assert.equal(isValidDateOnly("2026-02-31"), false);
  assert.equal(isValidDateOnly("2026-13-01"), false);
  assert.equal(isValidDateOnly("14-11-2026"), false);
  assert.equal(isValidDateOnly(""), false);
  assert.equal(isValidDateOnly(null), false);
});

test("knowledge approval accepts only explicit boolean values", () => {
  assert.equal(isOptionalBoolean(undefined), true);
  assert.equal(isOptionalBoolean(true), true);
  assert.equal(isOptionalBoolean(false), true);
  assert.equal(isOptionalBoolean("false"), false);
  assert.equal(isOptionalBoolean("true"), false);
  assert.equal(isOptionalBoolean(1), false);
  assert.equal(isOptionalBoolean(null), false);
});
