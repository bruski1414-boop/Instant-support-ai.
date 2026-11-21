"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveMewsAddonOrderReadback, SOURCE } = require("../mews-addon-order-readback");

function fixture(overrides = {}) {
  return {
    organizationId: "tenant-a",
    expectedEnterpriseId: "enterprise-a",
    paginationComplete: true,
    writeRecord: {
      organizationId: "tenant-a",
      enterpriseId: "enterprise-a",
      serviceId: "service-a",
      reservationId: "reservation-a",
      externalIdentifier: "veyra-addon:write-1",
      mewsOrderId: "mews-order-7",
      status: "completed"
    },
    orderItems: [{
      Id: "item-1",
      EnterpriseId: "enterprise-a",
      ServiceId: "service-a",
      ServiceOrderId: "service-order-44",
      ExternalIdentifier: "veyra-addon:write-1"
    }],
    productServiceOrders: [{
      Id: "service-order-44",
      ServiceId: "service-a",
      LinkedReservationId: "reservation-a",
      State: "Confirmed",
      CancelledUtc: null
    }],
    ...overrides
  };
}

test("verifies exact external identifier through item and service-order readback without equating OrderId to ServiceOrderId", () => {
  const result = resolveMewsAddonOrderReadback(fixture());
  assert.equal(result.mewsOrderId, "mews-order-7");
  assert.equal(result.serviceOrderId, "service-order-44");
  assert.notEqual(result.mewsOrderId, result.serviceOrderId);
  assert.equal(result.source, SOURCE);
});

test("requires complete pagination and a completed server-owned tenant write", () => {
  assert.throws(() => resolveMewsAddonOrderReadback(fixture({ paginationComplete: false })), /Complete.*pagination/);
  const uncertain = fixture();
  uncertain.writeRecord.status = "uncertain";
  assert.throws(() => resolveMewsAddonOrderReadback(uncertain), /completed server-owned/);
  const crossTenant = fixture();
  crossTenant.writeRecord.organizationId = "tenant-b";
  assert.throws(() => resolveMewsAddonOrderReadback(crossTenant), /completed server-owned/);
});

test("rejects missing, duplicate or cross-enterprise order-item matches", () => {
  const missing = fixture();
  missing.orderItems = [];
  assert.throws(() => resolveMewsAddonOrderReadback(missing), /resolve to one/);

  const duplicate = fixture();
  duplicate.orderItems.push({ ...duplicate.orderItems[0], Id: "item-2" });
  assert.throws(() => resolveMewsAddonOrderReadback(duplicate), /resolve to one/);

  const wrongEnterprise = fixture();
  wrongEnterprise.orderItems[0].EnterpriseId = "enterprise-b";
  assert.throws(() => resolveMewsAddonOrderReadback(wrongEnterprise), /different enterprise/);
});

test("requires one matching product service order with the exact service and reservation link", () => {
  const wrongReservation = fixture();
  wrongReservation.productServiceOrders[0].LinkedReservationId = "reservation-b";
  assert.throws(() => resolveMewsAddonOrderReadback(wrongReservation), /does not verify/);

  const wrongService = fixture();
  wrongService.productServiceOrders[0].ServiceId = "service-b";
  assert.throws(() => resolveMewsAddonOrderReadback(wrongService), /does not verify/);

  const canceled = fixture();
  canceled.productServiceOrders[0].State = "Canceled";
  assert.throws(() => resolveMewsAddonOrderReadback(canceled), /does not verify/);
});

test("rejects duplicate provider identifiers and never returns guest or account fields", () => {
  const duplicate = fixture();
  duplicate.productServiceOrders.push({ ...duplicate.productServiceOrders[0] });
  assert.throws(() => resolveMewsAddonOrderReadback(duplicate), /duplicate IDs/);

  const result = resolveMewsAddonOrderReadback(fixture());
  assert.equal(Object.hasOwn(result, "accountId"), false);
  assert.equal(Object.hasOwn(result, "guestName"), false);
});
