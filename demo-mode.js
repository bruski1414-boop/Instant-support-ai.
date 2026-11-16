"use strict";

const DEMO_HOTEL = Object.freeze({
  name: "Aster House Hotel",
  location: "Phuket, Thailand",
  checkIn: "3:00 PM",
  checkOut: "11:00 AM",
  breakfast: "6:30 AM–10:30 AM",
  pool: "7:00 AM–9:00 PM",
  wifi: "The complimentary Wi-Fi network is Aster-Guest. Reception provides the access code at check-in."
});

const SAMPLE_STAY = Object.freeze({
  arrivalDate: "2026-12-10",
  departureDate: "2026-12-12",
  roomTypes: Object.freeze([
    Object.freeze({ name: "Deluxe", nightlyAvailability: Object.freeze([3, 2]) }),
    Object.freeze({ name: "Garden Suite", nightlyAvailability: Object.freeze([1, 1]) })
  ])
});

const DEMO_METRICS = Object.freeze({
  demoOnly: true,
  label: "Illustrative sample data — not hotel performance",
  period: "Illustrative 30-day sample",
  conversations: 126,
  resolvedWithoutStaff: 91,
  staffHandoffs: 35,
  medianFirstResponseSeconds: 8,
  hotelReportedBookingValueMinor: 325000,
  currency: "EUR",
  veyraLinkedRevenueMinor: 0,
  note: "The sample booking value is hotel-reported and is not attributed to Veyra. No real hotel revenue or customer outcomes are represented."
});

function safeMessage(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 1200) {
    throw new Error("Enter a message between 1 and 1,200 characters.");
  }
  return value.trim();
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return null;
  return time;
}

function handoff(reply, reason) {
  return Object.freeze({
    reply,
    needsHuman: true,
    handoffStatus: "demo_queue_only",
    handoffReason: reason,
    mode: "demo-simulation",
    demoOnly: true
  });
}

function respondToDemoMessage(input, stay = {}) {
  const message = safeMessage(input);
  const text = message.toLowerCase();

  if (/\b(allerg|allergic|medical|injur|emergency|unsafe|harass|discriminat)\b/.test(text)) {
    return handoff("I’m flagging this for the hotel team in this demonstration. For an urgent safety or medical issue, please contact hotel staff or local emergency services directly.", "Sensitive or safety-related request.");
  }
  if (/\b(refund|charged twice|payment failed|billing dispute|cancel(?:lation)?|change my booking|modify my reservation|book me|make a reservation|reserve me)\b/.test(text)) {
    return handoff("A hotel team member needs to handle that request in the booking system. In this demo, the handoff is shown on screen only; no real staff member is notified.", "Booking or payment action requires hotel staff.");
  }
  if (/\b(room|rooms|availability|available|vacancy)\b/.test(text) && /\b(check|available|availability|have|need|looking)\b/.test(text)) {
    const arrival = parseDate(stay.arrivalDate);
    const departure = parseDate(stay.departureDate);
    const sampleStart = parseDate(SAMPLE_STAY.arrivalDate);
    const sampleEnd = parseDate(SAMPLE_STAY.departureDate);
    if (!arrival || !departure || departure <= arrival) {
      return handoff("Please choose valid arrival and departure dates. This demo only has sample inventory for 10–12 December 2026; outside those dates, the hotel team would need to check its live system.", "Stay dates missing or invalid.");
    }
    if (arrival !== sampleStart || departure !== sampleEnd) {
      return handoff("I can’t verify those dates from this demonstration dataset. The hotel team would need to check its live property system and confirm the full stay.", "Requested dates are outside the demo inventory.");
    }
    const lines = SAMPLE_STAY.roomTypes.map(room => {
      const count = Math.min(...room.nightlyAvailability);
      return count > 0 ? room.name + ": " + count + " sample room(s) available for each night." : room.name + ": no sample rooms available for the full stay.";
    });
    return Object.freeze({
      reply: "For 10–12 December 2026, the demonstration inventory shows: " + lines.join(" ") + " This is simulated data only, not live hotel availability or a reservation.",
      needsHuman: false,
      handoffStatus: "not_required",
      handoffReason: "",
      mode: "demo-simulation",
      demoOnly: true
    });
  }
  if (/\b(check.?in|arrival time)\b/.test(text)) return Object.freeze({ reply: "Check-in at Aster House Hotel begins at 3:00 PM. This is approved sample hotel information in the demo.", needsHuman: false, handoffStatus: "not_required", handoffReason: "", mode: "demo-simulation", demoOnly: true });
  if (/\b(check.?out|departure time)\b/.test(text)) return Object.freeze({ reply: "Check-out is by 11:00 AM. If you need a later departure, I can flag a request for the hotel team; it is subject to confirmation.", needsHuman: false, handoffStatus: "not_required", handoffReason: "", mode: "demo-simulation", demoOnly: true });
  if (/\b(breakfast|morning meal)\b/.test(text)) return Object.freeze({ reply: "Breakfast is served from 6:30 AM to 10:30 AM in the Garden Dining Room.", needsHuman: false, handoffStatus: "not_required", handoffReason: "", mode: "demo-simulation", demoOnly: true });
  if (/\b(pool|swimming)\b/.test(text)) return Object.freeze({ reply: "The pool is open daily from 7:00 AM to 9:00 PM in this sample hotel profile.", needsHuman: false, handoffStatus: "not_required", handoffReason: "", mode: "demo-simulation", demoOnly: true });
  if (/\b(wi.?fi|internet|password)\b/.test(text)) return Object.freeze({ reply: DEMO_HOTEL.wifi, needsHuman: false, handoffStatus: "not_required", handoffReason: "", mode: "demo-simulation", demoOnly: true });
  if (/\b(airport|transfer|taxi|transport)\b/.test(text)) return handoff("Airport transfers can be requested through reception. A team member would need to confirm the vehicle, price and timing; none are booked in this demo.", "Transport arrangement needs staff confirmation.");
  if (/\b(human|real person|staff|reception|front desk|manager|concierge)\b/.test(text)) return handoff("I’ve added a simulated handoff to the on-screen staff queue. No real hotel employee has been contacted.", "Guest requested hotel staff.");
  if (/\b(hello|hi|hey|good morning|good afternoon)\b/.test(text)) return Object.freeze({ reply: "Hello and welcome to Aster House Hotel! I can help with hotel information, or demonstrate a sample room-availability check.", needsHuman: false, handoffStatus: "not_required", handoffReason: "", mode: "demo-simulation", demoOnly: true });
  return handoff("I don’t have an approved answer for that in this sample hotel knowledge base, so I’d send it to the hotel team rather than guess. The handoff shown here is simulated only.", "No approved answer found in demo knowledge.");
}

module.exports = { DEMO_HOTEL, SAMPLE_STAY, DEMO_METRICS, respondToDemoMessage };
