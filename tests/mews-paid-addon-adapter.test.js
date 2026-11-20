"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mapMewsPaidAddonEvidence,
  parseIsoDuration,
  addIsoDuration,
  minorUnitsFromGross
} = require("../mews-paid-addon-adapter");
const { createValidMewsAccountingFixture } = require("../fixtures/mews-paid-addon-accounting");

test("maps only a Veyra add-on with a verified reservation link, finalized Receipt and Charged payment", () => {
  const result = mapMewsPaidAddonEvidence(createValidMewsAccountingFixture());
  assert.equal(result.events.length, 1);
  assert.equal(result.withheld.length, 0);
  assert.equal(result.events[0].organizationId, "hotel-demo-tenant-a");
  assert.equal(result.events[0].provider, "mews");
  assert.equal(result.events[0].reservationId, "reservation-22");
  assert.equal(result.events[0].grossAmountMinor, 12500);
  assert.equal(result.events[0].amountMinor, 12500);
  assert.equal(result.events[0].currency, "EUR");
  assert.deepEqual(result.events[0].evidence.chargedPaymentIds, ["payment-5"]);
  assert.equal(result.attribution, "hotel_reported_unlinked");
  assert.equal("conversationId" in result.events[0], false);
});

test("does not copy guest, account, note, billing-name or payment-detail fields into evidence", () => {
  const result = mapMewsPaidAddonEvidence(createValidMewsAccountingFixture());
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("Synthetic Guest"), false);
  assert.equal(serialized.includes("Synthetic note"), false);
  assert.equal(serialized.includes("Synthetic payment note"), false);
  assert.equal(serialized.includes("BillingName"), false);
  assert.equal(serialized.includes("AssociatedAccountData"), false);
  assert.deepEqual(Object.keys(result.withheld), []);
});

test("requires a server-owned Mews LinkedReservationId write record and a currently confirmed reservation", () => {
  const noLink = createValidMewsAccountingFixture({ verifiedOrderItemWrites: [] });
  const noLinkResult = mapMewsPaidAddonEvidence(noLink);
  assert.equal(noLinkResult.events.length, 0);
  assert.equal(noLinkResult.withheld[0].reason, "reservation_link_not_verified_or_not_confirmed");

  const unconfirmed = createValidMewsAccountingFixture({ confirmedReservationIds: [] });
  const unconfirmedResult = mapMewsPaidAddonEvidence(unconfirmed);
  assert.equal(unconfirmedResult.events.length, 0);
  assert.equal(unconfirmedResult.withheld[0].reason, "reservation_link_not_verified_or_not_confirmed");
});

test("rejects cross-tenant or untrusted order-to-reservation link records", () => {
  const wrongTenant = createValidMewsAccountingFixture({
    verifiedOrderItemWrites: [{
      organizationId: "hotel-demo-tenant-b",
      enterpriseId: "enterprise-demo-a",
      serviceOrderId: "order-42",
      reservationId: "reservation-22",
      externalIdentifier: "veyra-addon:upgrade-101",
      source: "mews.orders.add.LinkedReservationId+Items.ExternalIdentifier"
    }]
  });
  assert.throws(() => mapMewsPaidAddonEvidence(wrongTenant), /server-owned, tenant-scoped/);

  const wrongSource = createValidMewsAccountingFixture({
    verifiedOrderItemWrites: [{
      organizationId: "hotel-demo-tenant-a",
      enterpriseId: "enterprise-demo-a",
      serviceOrderId: "order-42",
      reservationId: "reservation-22",
      externalIdentifier: "veyra-addon:upgrade-101",
      source: "guest-supplied"
    }]
  });
  assert.throws(() => mapMewsPaidAddonEvidence(wrongSource), /server-owned, tenant-scoped/);
});

test("does not accept a Veyra-looking identifier without its exact server-owned order-item write record", () => {
  const input = createValidMewsAccountingFixture();
  input.verifiedOrderItemWrites[0].externalIdentifier = "veyra-addon:different-item";
  const result = mapMewsPaidAddonEvidence(input);
  assert.equal(result.events.length, 0);
  assert.equal(result.withheld[0].reason, "reservation_link_not_verified_or_not_confirmed");
});

test("rejects provider rows from another Mews enterprise", () => {
  const input = createValidMewsAccountingFixture();
  input.payments[0].EnterpriseId = "enterprise-demo-b";
  assert.throws(() => mapMewsPaidAddonEvidence(input), /different enterprise/);
});

test("requires all API pages, corrective-bill coverage and rebate-chain coverage", () => {
  for (const field of ["paginationComplete", "correctionCoverageComplete", "rebateChainCoverageComplete"]) {
    const input = createValidMewsAccountingFixture({ [field]: false });
    assert.throws(() => mapMewsPaidAddonEvidence(input), /Complete pagination/);
  }
});

test("withholds an Invoice or an open bill instead of counting it as paid revenue", () => {
  const invoice = createValidMewsAccountingFixture();
  invoice.bills[0].Type = "Invoice";
  assert.equal(mapMewsPaidAddonEvidence(invoice).events.length, 0);

  const open = createValidMewsAccountingFixture();
  open.bills[0].State = "Open";
  assert.equal(mapMewsPaidAddonEvidence(open).events.length, 0);
});

test("withholds original receipts that have corrective bills or bill-level rebates", () => {
  const corrected = createValidMewsAccountingFixture();
  corrected.bills.push({
    Id: "bill-correction-1",
    EnterpriseId: "enterprise-demo-a",
    State: "Closed",
    Type: "Receipt",
    PaidUtc: "2026-11-10T09:00:00Z",
    CorrectionState: "CorrectiveBill",
    CorrectionType: "CreditNote",
    CorrectedBillId: "bill-9",
    Options: { Rebated: false }
  });
  assert.equal(mapMewsPaidAddonEvidence(corrected).events.length, 0);

  const rebatedBill = createValidMewsAccountingFixture();
  rebatedBill.bills[0].Options.Rebated = true;
  assert.equal(mapMewsPaidAddonEvidence(rebatedBill).events.length, 0);
});

test("withholds add-ons with direct or chained Mews rebate evidence", () => {
  const input = createValidMewsAccountingFixture();
  input.orderItems.push({
    Id: "rebate-1",
    EnterpriseId: "enterprise-demo-a",
    ServiceOrderId: "order-42",
    BillId: "bill-9",
    AccountingState: "Closed",
    Amount: { Currency: "EUR", GrossValue: -10, NetValue: -9.43 },
    Data: { Discriminator: "Rebate", Rebate: { RebatedItemId: "item-101" } }
  });
  const result = mapMewsPaidAddonEvidence(input);
  assert.equal(result.events.length, 0);
  assert.equal(result.withheld[0].reason, "rebate_chain_requires_reconciliation");
});

test("waits until the longer accounting and operational editable-history interval has elapsed", () => {
  const input = createValidMewsAccountingFixture();
  input.bills[0].PaidUtc = "2026-11-17T09:00:00Z";
  const result = mapMewsPaidAddonEvidence(input);
  assert.equal(result.events.length, 0);
  assert.equal(result.withheld[0].reason, "within_editable_history_window");
});

test("uses the latest bill and order-item update timestamp as the editable-history anchor", () => {
  const itemUpdated = createValidMewsAccountingFixture();
  itemUpdated.orderItems[0].UpdatedUtc = "2026-11-17T09:00:00Z";
  assert.equal(mapMewsPaidAddonEvidence(itemUpdated).withheld[0].reason, "within_editable_history_window");

  const billUpdated = createValidMewsAccountingFixture();
  billUpdated.bills[0].UpdatedUtc = "2026-11-17T09:00:00Z";
  assert.equal(mapMewsPaidAddonEvidence(billUpdated).withheld[0].reason, "within_editable_history_window");

  const missingUpdate = createValidMewsAccountingFixture();
  delete missingUpdate.bills[0].UpdatedUtc;
  assert.equal(mapMewsPaidAddonEvidence(missingUpdate).withheld[0].reason, "bill_update_timestamp_missing");
});

test("normalizes Mews UTC offsets to canonical timestamps", () => {
  const input = createValidMewsAccountingFixture();
  input.payments[0].ChargedUtc = "2026-11-01T09:00:00+00:00";
  const result = mapMewsPaidAddonEvidence(input);
  assert.equal(result.events[0].occurredAt, "2026-11-01T09:00:00.000Z");
});

test("requires bill paid timestamp and supported editable-history configuration", () => {
  const missingPaidAt = createValidMewsAccountingFixture();
  delete missingPaidAt.bills[0].PaidUtc;
  assert.equal(mapMewsPaidAddonEvidence(missingPaidAt).withheld[0].reason, "bill_paid_timestamp_missing");

  const unsupportedDuration = createValidMewsAccountingFixture();
  unsupportedDuration.configuration.Enterprise.AccountingEditableHistoryInterval = "P1W";
  assert.throws(() => mapMewsPaidAddonEvidence(unsupportedDuration), /supported ISO-8601 duration/);
});

test("requires Charged, closed, same-currency Mews Payment evidence and holds refunds/chargebacks", () => {
  const refund = createValidMewsAccountingFixture();
  refund.payments.push({
    Id: "refund-1",
    EnterpriseId: "enterprise-demo-a",
    BillId: "bill-9",
    State: "Charged",
    AccountingState: "Closed",
    Kind: "Refund",
    ChargedUtc: "2026-11-02T09:00:00Z",
    Amount: { Currency: "EUR", GrossValue: 25, NetValue: 25 }
  });
  assert.equal(mapMewsPaidAddonEvidence(refund).withheld[0].reason, "adjustment_needs_review");

  const missingKind = createValidMewsAccountingFixture();
  delete missingKind.payments[0].Kind;
  assert.equal(mapMewsPaidAddonEvidence(missingKind).withheld[0].reason, "payment_kind_unverified");

  const wrongCurrency = createValidMewsAccountingFixture();
  wrongCurrency.payments[0].Amount.Currency = "USD";
  assert.equal(mapMewsPaidAddonEvidence(wrongCurrency).withheld[0].reason, "payment_currency_mismatch");

  const positivePayment = createValidMewsAccountingFixture();
  positivePayment.payments[0].Amount.GrossValue = 135;
  assert.equal(mapMewsPaidAddonEvidence(positivePayment).withheld[0].reason, "payment_amount_sign_unverified");

  const pending = createValidMewsAccountingFixture();
  pending.payments[0].State = "Pending";
  assert.equal(mapMewsPaidAddonEvidence(pending).withheld[0].reason, "charged_payment_evidence_missing");
});

test("does not count cancelled, open or non-positive Veyra order items", () => {
  const cancelled = createValidMewsAccountingFixture();
  cancelled.orderItems[0].CanceledUtc = "2026-11-01T08:56:00Z";
  assert.equal(mapMewsPaidAddonEvidence(cancelled).withheld[0].reason, "order_item_not_closed");

  const open = createValidMewsAccountingFixture();
  open.orderItems[0].AccountingState = "Open";
  assert.equal(mapMewsPaidAddonEvidence(open).withheld[0].reason, "order_item_not_closed");

  const zero = createValidMewsAccountingFixture();
  zero.orderItems[0].Amount.GrossValue = 0;
  assert.equal(mapMewsPaidAddonEvidence(zero).withheld[0].reason, "order_item_amount_not_positive_or_exact");

  const rebate = createValidMewsAccountingFixture();
  rebate.orderItems[0].Amount.GrossValue = -125;
  assert.equal(mapMewsPaidAddonEvidence(rebate).withheld[0].reason, "order_item_amount_not_positive_or_exact");
});

test("ignores ordinary hotel order items without a Veyra-issued external identifier", () => {
  const input = createValidMewsAccountingFixture();
  input.orderItems[0].ExternalIdentifier = "hotel-front-desk";
  const result = mapMewsPaidAddonEvidence(input);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.withheld, []);
});

test("rejects duplicate provider identifiers and duplicate Veyra external identifiers", () => {
  const duplicateId = createValidMewsAccountingFixture();
  duplicateId.orderItems.push({ ...duplicateId.orderItems[0] });
  assert.throws(() => mapMewsPaidAddonEvidence(duplicateId), /duplicate identifiers/);

  const duplicateExternal = createValidMewsAccountingFixture();
  duplicateExternal.orderItems.push({
    ...duplicateExternal.orderItems[0],
    Id: "item-103"
  });
  assert.throws(() => mapMewsPaidAddonEvidence(duplicateExternal), /cannot identify multiple/);
});

test("does not combine currencies within one bill", () => {
  const input = createValidMewsAccountingFixture();
  input.orderItems[1].Amount.Currency = "USD";
  const result = mapMewsPaidAddonEvidence(input);
  assert.equal(result.events.length, 0);
  assert.equal(result.withheld[0].reason, "bill_currency_inconsistent");
});

test("supports ISO currency precision without rounding away unsupported decimals", () => {
  assert.equal(minorUnitsFromGross(125, "EUR"), 12500);
  assert.equal(minorUnitsFromGross(123, "JPY"), 123);
  assert.equal(minorUnitsFromGross(1.234, "KWD"), 1234);
  assert.equal(minorUnitsFromGross(1.234, "EUR"), null);
  assert.equal(minorUnitsFromGross(Number.MAX_VALUE, "EUR"), null);
});

test("applies calendar-month editable-history durations without month-end rollover", () => {
  const duration = parseIsoDuration("P1M");
  const start = Date.parse("2024-01-31T00:00:00.000Z");
  assert.equal(new Date(addIsoDuration(start, duration)).toISOString(), "2024-02-29T00:00:00.000Z");
  assert.equal(parseIsoDuration("P0M7DT0H0M0S").days, 7);
});

test("keeps multiple Veyra add-ons on one fully paid bill as separate evidence records", () => {
  const input = createValidMewsAccountingFixture();
  input.orderItems.push({
    ...input.orderItems[0],
    Id: "item-103",
    ExternalIdentifier: "veyra-addon:spa-103",
    Amount: { Currency: "EUR", GrossValue: 20, NetValue: 18.87 }
  });
  input.verifiedOrderItemWrites.push({
    organizationId: "hotel-demo-tenant-a",
    enterpriseId: "enterprise-demo-a",
    serviceOrderId: "order-42",
    reservationId: "reservation-22",
    externalIdentifier: "veyra-addon:spa-103",
    source: "mews.orders.add.LinkedReservationId+Items.ExternalIdentifier"
  });
  const result = mapMewsPaidAddonEvidence(input);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map(event => event.externalReference).sort(), ["item-101", "item-103"]);
});
