"use strict";

// Pure Mews Connector API mapper. No network or database I/O occurs here.
// Raw guest/account names, emails, notes and payment details are discarded.
// The caller supplies complete tenant-verified pages and server-owned links
// created from successful Mews orders/add responses.

const { reconcilePaidAddons } = require("./paid-addon-reconciliation");

const VEYRA_EXTERNAL_ID = /^veyra-addon:[A-Za-z0-9._:-]{1,120}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ADJUSTMENT_KINDS = new Set(["Refund", "Chargeback", "ChargebackReversal"]);
const ACTIVE_PAYMENT_STATES = new Set(["Charged", "Pending", "Verifying"]);

function requiredId(value, field) {
  if (typeof value !== "string" || !SAFE_ID.test(value.trim())) {
    throw new Error(field + " must be a valid opaque identifier.");
  }
  return value.trim();
}

function utcMillis(value, field) {
  if (typeof value !== "string" || !/(Z|\+00:00)$/.test(value)) {
    throw new Error(field + " must be an ISO-8601 UTC timestamp.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(field + " must be a valid UTC timestamp.");
  return parsed;
}

function canonicalUtc(value, field) {
  return new Date(utcMillis(value, field)).toISOString();
}

function currencyCode(value) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) return null;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: value });
    return value;
  } catch {
    return null;
  }
}

function minorUnitsFromGross(value, currency) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const code = currencyCode(currency);
  if (!code) return null;
  const digits = new Intl.NumberFormat("en", { style: "currency", currency: code })
    .resolvedOptions().maximumFractionDigits;
  const raw = String(Math.abs(value));
  if (/e/i.test(raw)) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;
  const fraction = match[2] || "";
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) return null;
  const scale = 10n ** BigInt(digits);
  const whole = BigInt(match[1]);
  const fractional = BigInt((fraction.slice(0, digits) + "0".repeat(digits)).slice(0, digits) || "0");
  const result = whole * scale + fractional;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(result);
}

function parseIsoDuration(value, field) {
  if (typeof value !== "string") throw new Error(field + " must be an ISO-8601 duration.");
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,3})?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(part => part !== undefined)) {
    throw new Error(field + " must be a supported ISO-8601 duration.");
  }
  const parts = match.slice(1).map(part => part === undefined ? 0 : Number(part));
  if (parts.some(part => !Number.isFinite(part))) throw new Error(field + " is invalid.");
  return {
    months: parts[0] * 12 + parts[1],
    days: parts[2],
    hours: parts[3],
    minutes: parts[4],
    seconds: parts[5]
  };
}

function addIsoDuration(startMs, duration) {
  const date = new Date(startMs);
  const originalDay = date.getUTCDate();
  const months = duration.months;
  if (!Number.isSafeInteger(months) || months < 0) throw new Error("Editable history month interval is invalid.");
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDay));
  const extraMs = duration.days * 86400000 + duration.hours * 3600000 +
    duration.minutes * 60000 + duration.seconds * 1000;
  const result = date.getTime() + extraMs;
  if (!Number.isFinite(result)) throw new Error("Editable history interval exceeds supported date range.");
  return result;
}

function uniqueRows(rows, field, expectedEnterpriseId) {
  if (!Array.isArray(rows)) throw new Error(field + " must be an array.");
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(field + " contains an invalid record.");
    const id = requiredId(row.Id, field + " Id");
    if (seen.has(id)) throw new Error(field + " contains duplicate identifiers.");
    seen.add(id);
    if (row.EnterpriseId !== expectedEnterpriseId) {
      throw new Error(field + " contains a record from a different enterprise.");
    }
  }
  return rows;
}

function buildRebateParents(orderItems) {
  const parents = new Map();
  for (const item of orderItems) {
    if (item.Data?.Discriminator !== "Rebate") continue;
    const rebatedItemId = item.Data?.Rebate?.RebatedItemId;
    if (typeof rebatedItemId !== "string" || !rebatedItemId) continue;
    if (!parents.has(rebatedItemId)) parents.set(rebatedItemId, []);
    parents.get(rebatedItemId).push(item.Id);
  }
  return parents;
}

function hasAnyRebateInChain(itemId, rebateParents) {
  const queue = [itemId];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const children = rebateParents.get(current) || [];
    if (children.length) return true;
    queue.push(...children);
  }
  return false;
}

function mapMewsPaidAddonEvidence(input = {}) {
  const organizationId = requiredId(input.organizationId, "organizationId");
  const expectedEnterpriseId = requiredId(input.expectedEnterpriseId, "expectedEnterpriseId");
  if (input.paginationComplete !== true ||
      input.correctionCoverageComplete !== true ||
      input.rebateChainCoverageComplete !== true) {
    throw new Error("Complete pagination, corrective-bill coverage and rebate-chain coverage are required.");
  }

  const configuration = input.configuration;
  if (!configuration || configuration.Enterprise?.Id !== expectedEnterpriseId) {
    throw new Error("Mews configuration must be verified for the selected enterprise.");
  }
  const nowMs = utcMillis(configuration.NowUtc, "configuration.NowUtc");
  const accountingInterval = parseIsoDuration(
    configuration.Enterprise.AccountingEditableHistoryInterval,
    "AccountingEditableHistoryInterval"
  );
  const operationalInterval = parseIsoDuration(
    configuration.Enterprise.OperationalEditableHistoryInterval,
    "OperationalEditableHistoryInterval"
  );

  const orderItems = uniqueRows(input.orderItems, "orderItems", expectedEnterpriseId);
  const bills = uniqueRows(input.bills, "bills", expectedEnterpriseId);
  const payments = uniqueRows(input.payments, "payments", expectedEnterpriseId);

  if (!Array.isArray(input.confirmedReservationIds) || !Array.isArray(input.verifiedOrderReservationLinks)) {
    throw new Error("Verified reservation IDs and server-owned order/reservation links are required.");
  }
  const confirmedReservations = new Set(input.confirmedReservationIds.map((id, index) =>
    requiredId(id, "confirmedReservationIds[" + index + "]")
  ));
  if (confirmedReservations.size !== input.confirmedReservationIds.length) {
    throw new Error("Confirmed reservation IDs must be unique.");
  }

  const orderLinks = new Map();
  for (const link of input.verifiedOrderReservationLinks) {
    if (!link || typeof link !== "object" || Array.isArray(link) ||
        link.organizationId !== organizationId || link.enterpriseId !== expectedEnterpriseId ||
        link.source !== "mews.orders.add.LinkedReservationId") {
      throw new Error("Order/reservation links must be server-owned, tenant-scoped Mews write evidence.");
    }
    const serviceOrderId = requiredId(link.serviceOrderId, "verified link serviceOrderId");
    const reservationId = requiredId(link.reservationId, "verified link reservationId");
    if (orderLinks.has(serviceOrderId)) throw new Error("A Mews service order cannot have multiple reservation links.");
    orderLinks.set(serviceOrderId, reservationId);
  }

  const billById = new Map(bills.map(bill => [bill.Id, bill]));
  const correctedBillIds = new Set(bills
    .filter(bill => bill.CorrectionState === "CorrectiveBill" && typeof bill.CorrectedBillId === "string")
    .map(bill => bill.CorrectedBillId));

  const itemCurrencyByBill = new Map();
  const invalidBillCurrency = new Set();
  for (const item of orderItems) {
    if (typeof item.BillId !== "string" || !item.BillId) continue;
    const code = currencyCode(item.Amount?.Currency);
    if (!code) {
      invalidBillCurrency.add(item.BillId);
      continue;
    }
    const previous = itemCurrencyByBill.get(item.BillId);
    if (previous && previous !== code) invalidBillCurrency.add(item.BillId);
    else itemCurrencyByBill.set(item.BillId, code);
  }

  const paymentsByBill = new Map();
  const blockedPaymentBills = new Map();
  for (const payment of payments) {
    if (typeof payment.BillId !== "string" || !payment.BillId) continue;
    const billId = payment.BillId;
    if (!paymentsByBill.has(billId)) paymentsByBill.set(billId, []);
    paymentsByBill.get(billId).push(payment);

    if (ADJUSTMENT_KINDS.has(payment.Kind) && ACTIVE_PAYMENT_STATES.has(payment.State)) {
      blockedPaymentBills.set(billId, "adjustment_needs_review");
    } else if (payment.Kind !== "Payment" && ACTIVE_PAYMENT_STATES.has(payment.State)) {
      blockedPaymentBills.set(billId, "payment_kind_unverified");
    } else if (payment.Kind === "Payment" && payment.State === "Charged" && payment.AccountingState !== "Closed") {
      blockedPaymentBills.set(billId, "payment_accounting_state_unclosed");
    }
  }

  const rebateParents = buildRebateParents(orderItems);
  const canonicalItems = [];
  const canonicalBills = new Map();
  const canonicalPayments = new Map();
  const withheld = [];
  const seenExternalIdentifiers = new Set();

  function hold(item, reason) {
    withheld.push(Object.freeze({ orderItemId: item.Id, reason }));
  }

  for (const item of orderItems) {
    const externalIdentifier = typeof item.ExternalIdentifier === "string" ? item.ExternalIdentifier.trim() : "";
    if (!externalIdentifier.startsWith("veyra-addon:")) continue;
    if (!VEYRA_EXTERNAL_ID.test(externalIdentifier)) {
      hold(item, "invalid_veyra_external_identifier");
      continue;
    }
    if (seenExternalIdentifiers.has(externalIdentifier)) {
      throw new Error("A Veyra external identifier cannot identify multiple Mews order items.");
    }
    seenExternalIdentifiers.add(externalIdentifier);

    const serviceOrderId = typeof item.ServiceOrderId === "string" ? item.ServiceOrderId : "";
    const reservationId = orderLinks.get(serviceOrderId);
    if (!reservationId || !confirmedReservations.has(reservationId)) {
      hold(item, "reservation_link_not_verified_or_not_confirmed");
      continue;
    }
    if (item.AccountingState !== "Closed" || item.CanceledUtc || !item.ClosedUtc) {
      hold(item, "order_item_not_closed");
      continue;
    }
    const itemClosedAtMs = utcMillis(item.ClosedUtc, "orderItem.ClosedUtc");
    if (typeof item.UpdatedUtc !== "string" || !item.UpdatedUtc) {
      hold(item, "order_item_update_timestamp_missing");
      continue;
    }
    const itemUpdatedAtMs = utcMillis(item.UpdatedUtc, "orderItem.UpdatedUtc");
    if (hasAnyRebateInChain(item.Id, rebateParents)) {
      hold(item, "rebate_chain_requires_reconciliation");
      continue;
    }

    const billId = typeof item.BillId === "string" ? item.BillId : "";
    const bill = billById.get(billId);
    if (!bill) {
      hold(item, "bill_missing");
      continue;
    }
    if (bill.State !== "Closed" || bill.Type !== "Receipt") {
      hold(item, "bill_not_closed_full_payment_receipt");
      continue;
    }
    if (bill.CorrectionState !== "Bill" || bill.Options?.Rebated !== false || correctedBillIds.has(bill.Id)) {
      hold(item, "bill_corrected_or_rebated");
      continue;
    }
    if (blockedPaymentBills.has(billId)) {
      hold(item, blockedPaymentBills.get(billId));
      continue;
    }
    if (invalidBillCurrency.has(billId)) {
      hold(item, "bill_currency_inconsistent");
      continue;
    }

    const itemCurrency = currencyCode(item.Amount?.Currency);
    const billCurrency = itemCurrencyByBill.get(billId);
    if (!itemCurrency || !billCurrency || itemCurrency !== billCurrency) {
      hold(item, "bill_currency_unverified");
      continue;
    }
    const grossValue = item.Amount?.GrossValue;
    const itemAmountMinor = minorUnitsFromGross(grossValue, itemCurrency);
    if (typeof grossValue !== "number" || grossValue <= 0 || !itemAmountMinor || itemAmountMinor <= 0) {
      hold(item, "order_item_amount_not_positive_or_exact");
      continue;
    }

    if (typeof bill.PaidUtc !== "string" || !bill.PaidUtc) {
      hold(item, "bill_paid_timestamp_missing");
      continue;
    }
    const paidAtMs = utcMillis(bill.PaidUtc, "bill.PaidUtc");
    if (typeof bill.UpdatedUtc !== "string" || !bill.UpdatedUtc) {
      hold(item, "bill_update_timestamp_missing");
      continue;
    }
    const billUpdatedAtMs = utcMillis(bill.UpdatedUtc, "bill.UpdatedUtc");
    const issuedAtMs = bill.IssuedUtc ? utcMillis(bill.IssuedUtc, "bill.IssuedUtc") : paidAtMs;
    const finalityAnchorMs = Math.max(paidAtMs, billUpdatedAtMs, issuedAtMs, itemClosedAtMs, itemUpdatedAtMs);
    const finalityAtMs = Math.max(
      addIsoDuration(finalityAnchorMs, accountingInterval),
      addIsoDuration(finalityAnchorMs, operationalInterval)
    );
    if (finalityAtMs > nowMs) {
      hold(item, "within_editable_history_window");
      continue;
    }

    const billPayments = paymentsByBill.get(billId) || [];
    const canonicalForBill = [];
    let paymentProblem = null;
    for (const payment of billPayments) {
      if (payment.Kind !== "Payment" || payment.State !== "Charged" || payment.AccountingState !== "Closed") continue;
      const paymentCurrency = currencyCode(payment.Amount?.Currency);
      const paymentGross = payment.Amount?.GrossValue;
      if (!paymentCurrency || paymentCurrency !== billCurrency) {
        paymentProblem = "payment_currency_mismatch";
        break;
      }
      if (typeof paymentGross !== "number" || paymentGross >= 0) {
        paymentProblem = "payment_amount_sign_unverified";
        break;
      }
      const amountMinor = minorUnitsFromGross(paymentGross, paymentCurrency);
      if (!amountMinor || amountMinor <= 0 || typeof payment.ChargedUtc !== "string" || !payment.ChargedUtc) {
        paymentProblem = "charged_payment_evidence_incomplete";
        break;
      }
      canonicalForBill.push({
        id: payment.Id,
        billId,
        status: "Charged",
        amountMinor,
        currency: paymentCurrency,
        occurredAt: canonicalUtc(payment.ChargedUtc, "payment.ChargedUtc")
      });
    }
    if (paymentProblem) {
      hold(item, paymentProblem);
      continue;
    }
    if (!canonicalForBill.length) {
      hold(item, "charged_payment_evidence_missing");
      continue;
    }

    canonicalItems.push({
      id: item.Id,
      externalIdentifier,
      reservationId,
      billId,
      accountingState: "Closed",
      amountMinor: itemAmountMinor,
      currency: itemCurrency
    });
    canonicalBills.set(billId, {
      id: billId,
      type: "Receipt",
      currency: billCurrency,
      paidInFull: true
    });
    for (const payment of canonicalForBill) canonicalPayments.set(payment.id, payment);
  }

  const events = canonicalItems.length
    ? reconcilePaidAddons({
        organizationId,
        provider: "mews",
        orderItems: canonicalItems,
        bills: [...canonicalBills.values()],
        payments: [...canonicalPayments.values()],
        adjustments: []
      })
    : [];

  return Object.freeze({
    events,
    withheld: Object.freeze(withheld),
    reportingStatus: "provider_evidence_reconciled_after_editable_history_window",
    attribution: "hotel_reported_unlinked"
  });
}

module.exports = { mapMewsPaidAddonEvidence, parseIsoDuration, addIsoDuration, minorUnitsFromGross };
