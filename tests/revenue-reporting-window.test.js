"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRevenueReportingWindow, MAX_WINDOW_DAYS } = require("../revenue-reporting-window");

const now = new Date("2026-11-16T15:30:00.000Z");

test("defaults to an explicit rolling 30-day window", () => {
 const result = resolveRevenueReportingWindow({}, now);
 assert.equal(result.mode, "rolling_30_days");
 assert.equal(result.windowDays, 30);
 assert.equal(result.windowStart, "2026-10-17T15:30:00.000Z");
 assert.equal(result.windowEnd, "2026-11-16T15:30:00.000Z");
 assert.equal(result.endExclusive, true);
});

test("uses inclusive calendar dates with an exclusive next-day SQL boundary", () => {
 const result = resolveRevenueReportingWindow({startDate:"2026-11-01",endDate:"2026-11-16"}, now);
 assert.equal(result.windowStart, "2026-11-01T00:00:00.000Z");
 assert.equal(result.windowEnd, "2026-11-17T00:00:00.000Z");
 assert.equal(result.windowDays, 16);
 assert.equal(result.mode, "calendar_dates_inclusive");
});

test("rejects partial date ranges", () => {
 assert.throws(() => resolveRevenueReportingWindow({startDate:"2026-11-01"}, now), /both startDate and endDate/);
 assert.throws(() => resolveRevenueReportingWindow({endDate:"2026-11-16"}, now), /both startDate and endDate/);
});

test("rejects invalid and impossible calendar dates", () => {
 assert.throws(() => resolveRevenueReportingWindow({startDate:"2026-02-30",endDate:"2026-03-01"}, now), /real calendar date/);
 assert.throws(() => resolveRevenueReportingWindow({startDate:"01-11-2026",endDate:"2026-11-16"}, now), /YYYY-MM-DD/);
});

test("rejects reversed and future date ranges", () => {
 assert.throws(() => resolveRevenueReportingWindow({startDate:"2026-11-17",endDate:"2026-11-16"}, now), /on or before/);
 assert.throws(() => resolveRevenueReportingWindow({startDate:"2026-11-16",endDate:"2026-11-17"}, now), /future/);
});

test("caps explicit reporting windows at 366 inclusive days", () => {
 assert.equal(resolveRevenueReportingWindow({startDate:"2025-11-16",endDate:"2026-11-16"}, now).windowDays, MAX_WINDOW_DAYS);
 assert.throws(() => resolveRevenueReportingWindow({startDate:"2025-11-15",endDate:"2026-11-16"}, now), /cannot exceed 366 days/);
});

test("does not mutate the supplied query", () => {
 const query = {startDate:"2026-11-01",endDate:"2026-11-16"};
 const copy = {...query};
 resolveRevenueReportingWindow(query, now);
 assert.deepEqual(query, copy);
});
