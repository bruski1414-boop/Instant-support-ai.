"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_DAYS = 366;

function parseDateOnly(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(field + " must use YYYY-MM-DD.");
  }
  const date = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(field + " must be a real calendar date.");
  }
  return date;
}

function resolveRevenueReportingWindow(query = {}, now = new Date()) {
  if (!now || !Number.isFinite(new Date(now).getTime())) throw new Error("A valid current date is required.");
  const hasStart = Object.prototype.hasOwnProperty.call(query, "startDate");
  const hasEnd = Object.prototype.hasOwnProperty.call(query, "endDate");
  if (hasStart !== hasEnd) throw new Error("Provide both startDate and endDate, or neither.");

  const current = new Date(now);
  let start;
  let endExclusive;
  let startDate;
  let endDate;
  let mode;

  if (!hasStart) {
    endExclusive = current;
    start = new Date(current.getTime() - 30 * DAY_MS);
    startDate = start.toISOString().slice(0, 10);
    endDate = current.toISOString().slice(0, 10);
    mode = "rolling_30_days";
  } else {
    const startDay = parseDateOnly(query.startDate, "startDate");
    const endDay = parseDateOnly(query.endDate, "endDate");
    const today = new Date(current.toISOString().slice(0, 10) + "T00:00:00.000Z");
    if (endDay > today) throw new Error("endDate cannot be in the future.");
    if (startDay > endDay) throw new Error("startDate must be on or before endDate.");
    start = startDay;
    endExclusive = new Date(endDay.getTime() + DAY_MS);
    const days = (endExclusive.getTime() - start.getTime()) / DAY_MS;
    if (days > MAX_WINDOW_DAYS) throw new Error("Reporting windows cannot exceed " + MAX_WINDOW_DAYS + " days.");
    startDate = query.startDate;
    endDate = query.endDate;
    mode = "calendar_dates_inclusive";
  }

  const windowDays = Math.ceil((endExclusive.getTime() - start.getTime()) / DAY_MS);
  return Object.freeze({
    windowStart: start.toISOString(),
    windowEnd: endExclusive.toISOString(),
    windowDays,
    startDate,
    endDate,
    mode,
    endExclusive: true
  });
}

module.exports = { resolveRevenueReportingWindow, MAX_WINDOW_DAYS };
