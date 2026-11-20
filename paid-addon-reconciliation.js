"use strict";

// Provider-neutral, read-only reconciliation of Veyra-created add-ons.
// Inputs are canonical records produced by a separately reviewed provider mapper.
// This module never calls a PMS, creates an order, or writes the revenue ledger.

const CURRENCY = /^[A-Z]{3}$/;
const VEYRA_EXTERNAL_ID = /^veyra-addon:[A-Za-z0-9._:-]{1,120}$/;
const REFERENCE = /^[A-Za-z0-9._:/# -]{1,200}$/;

function requiredText(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      value.split("").some(ch => ch.charCodeAt(0) < 32)) {
    throw new Error(field + " is required and must be valid text.");
  }
  return value.trim();
}

function positiveMinor(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(field + " must be a positive integer in minor currency units.");
  }
  return value;
}

function currency(value) {
  const code = requiredText(value, "currency", 3).toUpperCase();
  if (!CURRENCY.test(code)) throw new Error("currency must be a three-letter ISO code.");
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
  } catch {
    throw new Error("currency must be a supported ISO 4217 code.");
  }
  return code;
}

function timestamp(value, field) {
  const raw = requiredText(value, field, 40);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
    throw new Error(field + " must be a canonical ISO-8601 UTC timestamp.");
  }
  return raw;
}

function uniqueById(records, field) {
  if (!Array.isArray(records)) throw new Error(field + " must be an array.");
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(field + " contains an invalid record.");
    }
    const id = requiredText(record.id, field + " id");
    if (seen.has(id)) throw new Error(field + " contains duplicate identifiers.");
    seen.add(id);
  }
  return records;
}

/**
 * Reconcile canonical provider evidence without network or database I/O.
 *
 * A paid add-on is emitted only when a Veyra-issued item is linked to a
 * confirmed reservation, has a closed bill normalized as a full-payment
 * Receipt, and has same-currency Charged payment evidence. The provider mapper
 * must prove these relationships from documented provider fields.
 */
function reconcilePaidAddons({ organizationId, provider, orderItems, bills, payments, adjustments = [] } = {}) {
  const tenant = requiredText(organizationId, "organizationId", 80);
  const trustedProvider = requiredText(provider, "trusted provider", 80);
  const items = uniqueById(orderItems, "orderItems");
  const billRows = uniqueById(bills, "bills");
  const paymentRows = uniqueById(payments, "payments");
  if (!Array.isArray(adjustments)) throw new Error("adjustments must be an array.");

  const itemById = new Map(items.map(row => [row.id, row]));
  const billById = new Map(billRows.map(row => [row.id, row]));
  const paymentsByBill = new Map();
  for (const payment of paymentRows) {
    const billId = requiredText(payment.billId, "payment billId");
    if (!paymentsByBill.has(billId)) paymentsByBill.set(billId, []);
    paymentsByBill.get(billId).push(payment);
  }

  const adjustmentsByItem = new Map();
  const adjustmentReferences = new Set();
  for (const adjustment of adjustments) {
    const itemId = requiredText(adjustment.itemId, "adjustment itemId");
    if (!itemById.has(itemId)) throw new Error("An adjustment must reference an order item in this batch.");
    const reference = requiredText(adjustment.externalReference, "adjustment externalReference");
    if (!REFERENCE.test(reference) || adjustmentReferences.has(reference)) {
      throw new Error("Adjustment references must be valid and unique in this reconciliation batch.");
    }
    adjustmentReferences.add(reference);
    if (adjustment.status !== "confirmed" || !["refund", "chargeback"].includes(adjustment.type)) {
      throw new Error("Only confirmed refund or chargeback adjustments are eligible.");
    }
    const normalized = {
      type: adjustment.type,
      amountMinor: positiveMinor(adjustment.amountMinor, "adjustment amountMinor"),
      currency: currency(adjustment.currency),
      occurredAt: timestamp(adjustment.occurredAt, "adjustment occurredAt"),
      externalReference: reference
    };
    if (!adjustmentsByItem.has(itemId)) adjustmentsByItem.set(itemId, []);
    adjustmentsByItem.get(itemId).push(normalized);
  }

  const externalIds = new Set();
  const output = [];
  for (const item of items) {
    const externalIdentifier = typeof item.externalIdentifier === "string" ? item.externalIdentifier.trim() : "";
    if (!VEYRA_EXTERNAL_ID.test(externalIdentifier)) continue;
    if (externalIds.has(externalIdentifier)) {
      throw new Error("A Veyra add-on external identifier cannot identify multiple order items.");
    }
    externalIds.add(externalIdentifier);

    if (item.accountingState !== "Closed" || !item.billId || !item.reservationId) continue;
    const billId = requiredText(item.billId, "order item billId");
    const bill = billById.get(billId);
    if (!bill || bill.type !== "Receipt") continue;

    const itemCurrency = currency(item.currency);
    const itemAmount = positiveMinor(item.amountMinor, "order item amountMinor");
    const billCurrency = currency(bill.currency);
    const hasBillTotal = bill.totalAmountMinor !== undefined && bill.totalAmountMinor !== null;
    const billTotal = hasBillTotal ? positiveMinor(bill.totalAmountMinor, "bill totalAmountMinor") : null;
    if (itemCurrency !== billCurrency ||
        (!hasBillTotal && bill.paidInFull !== true) ||
        (hasBillTotal && itemAmount > billTotal)) continue;

    const linkedPayments = paymentsByBill.get(billId) || [];
    const charged = linkedPayments.filter(payment =>
      payment.status === "Charged" &&
      currency(payment.currency) === billCurrency &&
      Number.isSafeInteger(payment.amountMinor) && payment.amountMinor > 0
    );
    const chargedTotal = charged.reduce((sum, payment) => sum + payment.amountMinor, 0);
    if (!Number.isSafeInteger(chargedTotal) || !charged.length ||
        (hasBillTotal && chargedTotal < billTotal)) continue;

    const itemAdjustments = adjustmentsByItem.get(item.id) || [];
    let adjustmentTotal = 0;
    for (const adjustment of itemAdjustments) {
      if (adjustment.currency !== itemCurrency) throw new Error("Adjustment currency must match the original add-on.");
      adjustmentTotal += adjustment.amountMinor;
      if (!Number.isSafeInteger(adjustmentTotal) || adjustmentTotal > itemAmount) {
        throw new Error("Refunds and chargebacks cannot exceed the original paid add-on amount.");
      }
    }
    const netAmountMinor = itemAmount - adjustmentTotal;
    const paidAt = charged.map(payment => timestamp(payment.occurredAt, "payment occurredAt")).sort().at(-1);
    output.push(Object.freeze({
      organizationId: tenant,
      provider: trustedProvider,
      type: "addon_paid",
      status: "paid_addon_verified",
      externalReference: requiredText(item.id, "order item id"),
      sourceReference: billId,
      reservationId: requiredText(item.reservationId, "reservationId"),
      externalIdentifier,
      grossAmountMinor: itemAmount,
      adjustmentAmountMinor: adjustmentTotal,
      amountMinor: netAmountMinor,
      currency: itemCurrency,
      occurredAt: paidAt,
      adjustments: Object.freeze(itemAdjustments.map(adjustment => Object.freeze({ ...adjustment }))),
      evidence: Object.freeze({
        billType: "Receipt",
        billId,
        chargedPaymentIds: Object.freeze(charged.map(payment => requiredText(payment.id, "payment id")).sort()),
        adjustmentReferences: Object.freeze(itemAdjustments.map(adjustment => adjustment.externalReference).sort())
      })
    }));
  }
  return Object.freeze(output);
}

module.exports = { reconcilePaidAddons };
