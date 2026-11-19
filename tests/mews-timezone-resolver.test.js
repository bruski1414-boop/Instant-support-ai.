"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsTimeUnitResolver } = require("../mews-timezone-resolver");

test("maps hotel local midnights across the spring DST transition", async () => {
  const resolve = createMewsTimeUnitResolver("America/New_York");
  const values = await resolve({ arrivalDate: "2026-03-07", departureDate: "2026-03-10" });
  assert.deepEqual(values, [
    "2026-03-07T05:00:00.000Z",
    "2026-03-08T05:00:00.000Z",
    "2026-03-09T04:00:00.000Z"
  ]);
  assert.equal(Date.parse(values[2]) - Date.parse(values[1]), 23 * 60 * 60 * 1000);
});

test("maps hotel local midnights across the autumn DST transition", async () => {
  const resolve = createMewsTimeUnitResolver("America/New_York");
  const values = await resolve({ arrivalDate: "2026-10-31", departureDate: "2026-11-03" });
  assert.deepEqual(values, [
    "2026-10-31T04:00:00.000Z",
    "2026-11-01T04:00:00.000Z",
    "2026-11-02T05:00:00.000Z"
  ]);
  assert.equal(Date.parse(values[2]) - Date.parse(values[1]), 25 * 60 * 60 * 1000);
});

test("maps a hotel timezone without assuming UTC", async () => {
  const resolve = createMewsTimeUnitResolver("Asia/Bangkok");
  assert.deepEqual(await resolve({
    arrivalDate: "2026-11-19",
    departureDate: "2026-11-21"
  }), [
    "2026-11-18T17:00:00.000Z",
    "2026-11-19T17:00:00.000Z"
  ]);
});

test("rejects invalid timezones, dates and stay ranges", async () => {
  assert.throws(() => createMewsTimeUnitResolver("Not/A_Timezone"), /IANA timezone/);
  const resolve = createMewsTimeUnitResolver("UTC");
  await assert.rejects(() => resolve({ arrivalDate: "2026-02-30", departureDate: "2026-03-02" }), /real calendar date/);
  await assert.rejects(() => resolve({ arrivalDate: "2026-03-02", departureDate: "2026-03-02" }), /between 1 and 367 nights/);
});
