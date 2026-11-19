"use strict";

/**
 * Creates a Mews day-unit resolver for one hotel's IANA timezone.
 * Each returned timestamp is the UTC instant corresponding to local midnight
 * on each occupied hotel night. DST transitions are handled by Intl rather
 * than assuming every hotel day is 24 hours. Ambiguous/nonexistent midnight
 * mappings fail closed.
 */
function validDate(value, field) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) {
    throw new Error(field + " must use YYYY-MM-DD.");
  }
  const parsed = Date.parse(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error(field + " must be a real calendar date.");
  }
  return parsed;
}

function createMewsTimeUnitResolver(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.trim() || timeZone.length > 100) {
    throw new Error("A valid IANA hotel timezone is required.");
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    formatter.format(new Date(0));
  } catch {
    throw new Error("Hotel timezone must be a supported IANA timezone.");
  }

  function localMidnightUtc(dateEpoch) {
    const desired = dateEpoch;
    let candidate = desired;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(candidate))
          .filter(part => part.type !== "literal")
          .map(part => [part.type, Number(part.value)])
      );
      const represented = Date.UTC(
        parts.year, parts.month - 1, parts.day,
        parts.hour, parts.minute, parts.second
      );
      const correction = desired - represented;
      if (correction === 0) return new Date(candidate).toISOString();
      candidate += correction;
    }

    throw new Error("Hotel local midnight could not be mapped unambiguously to UTC.");
  }

  return async function resolveTimeUnits({ arrivalDate, departureDate } = {}) {
    const arrival = validDate(arrivalDate, "arrivalDate");
    const departure = validDate(departureDate, "departureDate");
    const nights = (departure - arrival) / 86400000;
    if (!Number.isInteger(nights) || nights < 1 || nights > 367) {
      throw new Error("Stay must contain between 1 and 367 nights.");
    }

    const boundaries = [];
    for (let index = 0; index < nights; index += 1) {
      boundaries.push(localMidnightUtc(arrival + index * 86400000));
    }

    if (boundaries.some((value, index) =>
      index > 0 && Date.parse(value) <= Date.parse(boundaries[index - 1]))) {
      throw new Error("Hotel timezone produced non-increasing Mews time-unit boundaries.");
    }
    return boundaries;
  };
}

module.exports = { createMewsTimeUnitResolver };
