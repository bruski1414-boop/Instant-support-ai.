"use strict";

const { getMewsRoomNightSnapshots } = require("./mews-live-context");

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(date, amount) {
  const d = new Date(date + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

function localMidnightToUtc(date, timeZone) {
  if (!validDate(date)) throw new Error("Stay dates must use YYYY-MM-DD.");
  const target = Date.parse(date + "T00:00:00.000Z");
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    const correction = target - represented;
    guess += correction;
    if (correction === 0) break;
  }
  const finalParts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  if (finalParts.year + "-" + finalParts.month + "-" + finalParts.day !== date || finalParts.hour !== "00" || finalParts.minute !== "00" || finalParts.second !== "00") {
    throw new Error("Property-local midnight is not representable for this date.");
  }
  return new Date(guess).toISOString();
}

function buildMewsStayAvailabilityContext({
  connection, arrivalDate, departureDate, nowUtc = new Date().toISOString()
} = {}) {
  return (async () => {
    if (!connection || !connection.client || !connection.service) {
      return { verified: false, context: "No verified Mews connection is available. Do not claim room availability; offer hotel staff assistance." };
    }
    if (!validDate(arrivalDate) || !validDate(departureDate) || departureDate <= arrivalDate) {
      return { verified: false, reason: "invalid_dates", context: "The guest's stay dates are missing or invalid. Ask for arrival and departure dates; do not guess." };
    }
    const todayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: connection.timeZone, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date(nowUtc)).map(p => [p.type, p.value]));
    const today = todayParts.year + "-" + todayParts.month + "-" + todayParts.day;
    if (arrivalDate < today) {
      return { verified: false, reason: "past_dates", context: "The requested arrival date is in the past. Ask the guest for future stay dates; do not check or describe past inventory." };
    }
    const nights = Math.round((Date.parse(departureDate + "T00:00:00Z") - Date.parse(arrivalDate + "T00:00:00Z")) / 86400000);
    if (nights > 30) {
      return { verified: false, reason: "stay_too_long", context: "This availability lookup supports stays up to 30 nights. Ask hotel staff to check this longer stay." };
    }
    try {
      const firstTimeUnitStartUtc = localMidnightToUtc(arrivalDate, connection.timeZone);
      const lastTimeUnitStartUtc = localMidnightToUtc(addDays(departureDate, -1), connection.timeZone);
      const snapshots = await getMewsRoomNightSnapshots({
        client: connection.client,
        service: connection.service,
        propertyReference: connection.propertyReference,
        timeZone: connection.timeZone,
        firstTimeUnitStartUtc,
        lastTimeUnitStartUtc,
        nowUtc
      });
      const requestedDates = Array.from({ length: nights }, (_, i) => addDays(arrivalDate, i));
      const categories = [...new Set(snapshots.map(s => s.roomTypeCode))];
      const summaries = [];
      for (const category of categories) {
        const rows = snapshots.filter(s => s.roomTypeCode === category);
        const byDate = new Map(rows.map(s => [s.arrivalDate, s]));
        if (!requestedDates.every(date => byDate.has(date))) continue;
        summaries.push({
          category,
          minimumAvailable: Math.min(...requestedDates.map(date => byDate.get(date).roomsAvailable))
        });
      }
      if (!summaries.length) {
        return { verified: false, reason: "incomplete_inventory", context: "Mews did not return a complete verified availability result for every night of the requested stay. Do not infer availability; ask hotel staff to confirm." };
      }
      const lines = [
        "VERIFIED LIVE MEWS AVAILABILITY FOR THE ENTIRE REQUESTED STAY.",
        "Arrival: " + arrivalDate + ". Departure: " + departureDate + ". Nights: " + nights + ".",
        "The following counts are the minimum number of rooms available in each category across every night, not a booking or hold."
      ];
      for (const item of summaries) {
        lines.push("Room category " + item.category + ": at least " + item.minimumAvailable + " room(s) available on each night of the full stay.");
      }
      lines.push("Never claim a reservation has been made, held, or confirmed. Staff must handle booking and final confirmation.");
      return { verified: true, arrivalDate, departureDate, nights, summaries, snapshots, context: lines.join("\n") };
    } catch {
      return { verified: false, reason: "provider_unavailable", context: "The live Mews availability check failed. Do not claim availability; offer hotel staff assistance." };
    }
  })();
}

module.exports = { buildMewsStayAvailabilityContext, localMidnightToUtc };
