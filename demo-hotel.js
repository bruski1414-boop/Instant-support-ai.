const { generateGuestSupportAnswer } = require("./guest-support-engine");

const DEMO_HOTEL_NAME = "Northstar Hotel (fictional demo)";
const DEMO_HOTEL_KNOWLEDGE = [
  "This is a fictional demonstration property. These details are invented sample data and do not describe a real hotel.",
  "Check-in begins at 3:00 PM. Check-out is by 11:00 AM.",
  "Breakfast is served from 7:00 AM to 10:30 AM at the Ocean Terrace.",
  "The sample infinity pool is open from 7:00 AM to 8:00 PM.",
  "The sample fitness room is open from 6:00 AM to 10:00 PM.",
  "Airport transfers can be requested through the concierge. Price, availability and arrangements require staff confirmation.",
  "The demo has no verified local attractions, live room inventory, room rates, payment processing or booking capability.",
  "For any fact not stated here, say it cannot be verified and recommend contacting hotel staff."
].join("\n");

async function generateDemoHotelAnswer({ ai, model, message, history }) {
  return generateGuestSupportAnswer({
    ai,
    model,
    hotelName: DEMO_HOTEL_NAME,
    approvedKnowledge: DEMO_HOTEL_KNOWLEDGE,
    history,
    message,
  });
}

module.exports = {
  DEMO_HOTEL_NAME,
  DEMO_HOTEL_KNOWLEDGE,
  generateDemoHotelAnswer,
};
