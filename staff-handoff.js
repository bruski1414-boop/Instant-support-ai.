function applyExplicitStaffHandoff(answer, requiresStaff) {
  if (!answer || typeof answer !== "object") throw new TypeError("An answer object is required.");
  if (!requiresStaff || answer.needsHuman) return answer;
  answer.reply = "Of course. I’ll pass your request to the hotel team so a member of staff can assist you.";
  answer.needsHuman = true;
  answer.handoffReason = "Guest explicitly requested staff assistance or raised an issue requiring human review.";
  return answer;
}

module.exports = { applyExplicitStaffHandoff };
