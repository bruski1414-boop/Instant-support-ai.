"use strict";

// Synthetic, non-production Mews Connector API-shaped fixture.
// All identifiers and values are fictional; no guest/account PII is present.

function createValidMewsAccountingFixture(overrides = {}) {
  const input = {
    organizationId: "hotel-demo-tenant-a",
    expectedEnterpriseId: "enterprise-demo-a",
    paginationComplete: true,
    correctionCoverageComplete: true,
    rebateChainCoverageComplete: true,
    configuration: {
      NowUtc: "2026-11-20T09:00:00Z",
      Enterprise: {
        Id: "enterprise-demo-a",
        AccountingEditableHistoryInterval: "P0M7DT0H0M0S",
        OperationalEditableHistoryInterval: "P0M5DT0H0M0S"
      }
    },
    confirmedReservationIds: ["reservation-22"],
    verifiedOrderReservationLinks: [{
      organizationId: "hotel-demo-tenant-a",
      enterpriseId: "enterprise-demo-a",
      serviceOrderId: "order-42",
      reservationId: "reservation-22",
      source: "mews.orders.add.LinkedReservationId"
    }],
    orderItems: [
      {
        Id: "item-101",
        EnterpriseId: "enterprise-demo-a",
        ServiceId: "service-spa",
        ServiceOrderId: "order-42",
        BillId: "bill-9",
        ExternalIdentifier: "veyra-addon:upgrade-101",
        AccountingState: "Closed",
        ClosedUtc: "2026-11-01T08:55:00Z",
        UpdatedUtc: "2026-11-01T08:55:00Z",
        CanceledUtc: null,
        Amount: { Currency: "EUR", GrossValue: 125, NetValue: 117.92 },
        Data: null,
        Notes: "Synthetic note must not be copied",
        BillingName: "Synthetic room upgrade",
        AccountId: "synthetic-account"
      },
      {
        Id: "item-102",
        EnterpriseId: "enterprise-demo-a",
        ServiceId: "service-spa",
        ServiceOrderId: "order-42",
        BillId: "bill-9",
        ExternalIdentifier: null,
        AccountingState: "Closed",
        ClosedUtc: "2026-11-01T08:55:00Z",
        CanceledUtc: null,
        Amount: { Currency: "EUR", GrossValue: 10, NetValue: 9.43 },
        Data: null
      }
    ],
    bills: [{
      Id: "bill-9",
      EnterpriseId: "enterprise-demo-a",
      State: "Closed",
      Type: "Receipt",
      PaidUtc: "2026-11-01T09:00:00Z",
      IssuedUtc: "2026-11-01T09:00:00Z",
      UpdatedUtc: "2026-11-01T09:00:00Z",
      CorrectionState: "Bill",
      CorrectedBillId: null,
      Options: { Rebated: false },
      AssociatedAccountData: [{ Name: "Synthetic Guest - do not copy" }]
    }],
    payments: [{
      Id: "payment-5",
      EnterpriseId: "enterprise-demo-a",
      BillId: "bill-9",
      State: "Charged",
      AccountingState: "Closed",
      Kind: "Payment",
      ChargedUtc: "2026-11-01T09:00:00Z",
      Amount: { Currency: "EUR", GrossValue: -135, NetValue: -135 },
      Notes: "Synthetic payment note must not be copied"
    }]
  };
  return {
    ...input,
    ...overrides,
    configuration: overrides.configuration || input.configuration,
    confirmedReservationIds: overrides.confirmedReservationIds || input.confirmedReservationIds,
    verifiedOrderReservationLinks: overrides.verifiedOrderReservationLinks || input.verifiedOrderReservationLinks,
    orderItems: overrides.orderItems || input.orderItems,
    bills: overrides.bills || input.bills,
    payments: overrides.payments || input.payments
  };
}

module.exports = { createValidMewsAccountingFixture };
