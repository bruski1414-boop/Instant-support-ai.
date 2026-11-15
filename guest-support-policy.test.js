const test = require("node:test");
const assert = require("node:assert/strict");
const { requiresStaffEscalation, buildGuestSupportSystemPrompt } = require("./guest-support-policy");

test("ordinary booking and reservation information does not automatically trigger staff handoff", () => {
  for (const message of [
    "What is your booking policy?",
    "What is your cancellation policy?",
    "How do I make a reservation?",
    "Do you have rooms available in July?",
    "What room rates do you offer?",
    "Can I book directly through your website?"
  ]) {
    assert.equal(requiresStaffEscalation(message), false, message);
  }
});

test("requests to change or cancel an existing booking trigger staff handoff", () => {
  for (const message of [
    "I need to cancel my reservation",
    "Please change my booking dates",
    "Can you extend my stay?",
    "I want to move my room reservation"
  ]) {
    assert.equal(requiresStaffEscalation(message), true, message);
  }
});

test("safety, medical, complaint and payment issues trigger staff handoff", () => {
  for (const message of [
    "I have a severe allergy",
    "There is a fire emergency",
    "I want to make a complaint",
    "I was charged twice",
    "I need a refund"
  ]) {
    assert.equal(requiresStaffEscalation(message), true, message);
  }
});

test("explicit requests to speak with staff trigger handoff", () => {
  for (const message of [
    "Can I speak to a human?",
    "Please connect me to the front desk",
    "I want to talk to the manager",
    "Let me speak to staff"
  ]) {
    assert.equal(requiresStaffEscalation(message), true, message);
  }
});

test("general questions about staff or hotel operations do not automatically trigger handoff", () => {
  for (const message of [
    "What time does the front desk open?",
    "Does the hotel have staff overnight?",
    "Can hotel staff help with luggage?"
  ]) {
    assert.equal(requiresStaffEscalation(message), false, message);
  }
});

test("the guest-support prompt distinguishes information requests from actions", () => {
  const prompt = buildGuestSupportSystemPrompt("Sample Hotel", "[rooms] Standard room");
  assert.match(prompt, /Do NOT escalate just because the words booking, reservation/);
  assert.match(prompt, /Never pretend an action was completed/);
  assert.match(prompt, /Approved hotel knowledge/);
});
