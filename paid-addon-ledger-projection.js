"use strict";

// Projects reconciled provider evidence into the existing owner-attested ledger API
// shape. This function does not persist, authenticate, assign a tenant, or claim
// Veyra attribution. The caller must submit through the authenticated tenant route.

function decimalAmount(minor, currency) {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error("Amount must be positive integer minor units.");
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  const scale = 10 ** digits;
  const whole = Math.floor(minor / scale);
  const fraction = String(minor % scale).padStart(digits, "0");
  return digits ? whole + "." + fraction : String(whole);
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " must be a canonical timestamp.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(field + " must be a canonical UTC timestamp.");
  }
  return value;
}

function projectPaidAddonToLedger(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("A reconciled add-on event is required.");
  if (event.type !== "addon_paid" || event.status !== "paid_addon_verified") throw new Error("Only verified paid add-ons can be projected.");
  if (!event.organizationId || typeof event.organizationId !== "string") throw new Error("A tenant-scoped reconciliation result is required.");
  if (!event.provider || typeof event.provider !== "string") throw new Error("Trusted provider evidence is required.");
  if (!event.externalReference || !event.sourceReference || !event.reservationId) throw new Error("Order item, bill and reservation references are required.");
  if (!event.evidence || event.evidence.billType !== "Receipt" || !Array.isArray(event.evidence.chargedPaymentIds) || event.evidence.chargedPaymentIds.length === 0) {
    throw new Error("Full-payment receipt and Charged payment evidence are required.");
  }
  if (!Number.isSafeInteger(event.grossAmountMinor) || event.grossAmountMinor <= 0 ||
      !Number.isSafeInteger(event.adjustmentAmountMinor) || event.adjustmentAmountMinor < 0 ||
      !Number.isSafeInteger(event.amountMinor) || event.amountMinor < 0 ||
      event.grossAmountMinor - event.adjustmentAmountMinor !== event.amountMinor) {
    throw new Error("Gross, adjustments and net amount must reconcile exactly.");
  }
  const currency = String(event.currency || "").toUpperCase();
  new Intl.NumberFormat("en", { style: "currency", currency });
  const occurredAt = canonicalTimestamp(event.occurredAt, "occurredAt");

  const revenueEvent = Object.freeze({
    type: "addon_paid",
    externalReference: event.externalReference,
    sourceReference: event.sourceReference,
    amountMinor: event.grossAmountMinor,
    currency,
    occurredAt
    // Deliberately no conversationId: PMS reservation evidence alone is not
    // evidence that Veyra influenced or caused the booking.
  });
  if (!Array.isArray(event.adjustments)) throw new Error("Confirmed adjustment detail is required.");
  const adjustmentByReference = new Map(event.adjustments.map(adjustment => [adjustment.externalReference, adjustment]));
  if (adjustmentByReference.size !== event.adjustments.length) throw new Error("Duplicate adjustment references are not allowed.");
  const references = event.evidence.adjustmentReferences;
  if (!Array.isArray(references) || adjustmentByReference.size !== references.length) {
    throw new Error("Adjustment evidence is incomplete.");
  }
  const adjustments = references.map(reference => {
    const evidence = adjustmentByReference.get(reference);
    const amountMinor = evidence?.amountMinor;
    const adjustmentCurrency = evidence?.currency;
    const type = evidence?.type;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
        adjustmentCurrency !== currency || !["refund", "chargeback"].includes(type)) {
      throw new Error("Each confirmed adjustment must include its amount, currency and type.");
    }
    return Object.freeze({
      type,
      originalType: "addon_paid",
      externalReference: reference,
      originalExternalReference: event.externalReference,
      sourceReference: reference,
      amount: decimalAmount(amountMinor, currency),
      currency,
      occurredAt: canonicalTimestamp(evidence.occurredAt, "adjustment occurredAt")
    });
  });
  const adjustmentMinor = adjustments.reduce((sum, item) => {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
    const [whole, fraction = ""] = item.amount.split(".");
    return sum + Number(whole) * (10 ** digits) + Number((fraction + "0".repeat(digits)).slice(0, digits) || 0);
  }, 0);
  if (!Number.isSafeInteger(adjustmentMinor) || adjustmentMinor !== event.adjustmentAmountMinor) {
    throw new Error("Projected adjustments do not equal the reconciled adjustment total.");
  }

  return Object.freeze({
    revenueEvent,
    adjustments: Object.freeze(adjustments),
    attribution: "hotel_reported_unlinked",
    note: "Owner/admin review and authenticated tenant-scoped ledger submission required. This evidence does not establish Veyra causation."
  });
}

module.exports = { projectPaidAddonToLedger };
