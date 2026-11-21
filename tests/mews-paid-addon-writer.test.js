"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMewsPaidAddonWriter } = require("../mews-paid-addon-writer");

function setup(overrides = {}) {
  const now = Date.parse("2026-11-21T09:00:00.000Z");
  const calls = [];
  const state = { claim: { status: "acquired", externalIdentifier: "veyra-addon:write-1" }, completed: null, uncertain: null };
  const client = {
    tenantId: "tenant-a",
    environment: "demo",
    writeEnabled: true,
    async addOrder(payload) {
      calls.push(payload);
      if (overrides.addOrder) return overrides.addOrder(payload);
      return { OrderId: "mews-order-7" };
    }
  };
  const store = {
    async claim(input) { state.claimInput = input; return overrides.claim ? overrides.claim(input) : state.claim; },
    async complete(input) { state.completed = input; if (overrides.complete) return overrides.complete(input); },
    async markUncertain(input) { state.uncertain = input; if (overrides.markUncertain) return overrides.markUncertain(input); }
  };
  const writer = createMewsPaidAddonWriter({
    client: overrides.client || client,
    idempotencyStore: store,
    now: () => now,
    idFactory: () => "fixed-uuid-1"
  });
  const input = {
    organizationId: "tenant-a",
    idempotencyKey: "guest-request-001",
    connection: {
      organizationId: "tenant-a",
      enterpriseId: "enterprise-a",
      environment: "demo",
      status: "connected",
      verified: true,
      verifiedAt: "2026-11-20T09:00:00.000Z"
    },
    product: {
      organizationId: "tenant-a",
      enterpriseId: "enterprise-a",
      serviceId: "service-a",
      productId: "hotel-product-1",
      approved: true,
      active: true
    },
    reservation: {
      organizationId: "tenant-a",
      enterpriseId: "enterprise-a",
      id: "reservation-a",
      accountId: "opaque-account-a",
      state: "Confirmed",
      fetchedAt: "2026-11-21T08:59:00.000Z",
      validUntil: "2026-11-21T09:04:00.000Z"
    },
    count: 1
  };
  return { writer, input, client, store, calls, state };
}

test("submits one hotel-approved product linked to a fresh confirmed reservation", async () => {
  const s = setup();
  const result = await s.writer.addProductToReservation(s.input);
  assert.equal(result.status, "submitted_pending_readback");
  assert.equal(result.mewsOrderId, "mews-order-7");
  assert.equal(result.externalIdentifier, "veyra-addon:fixed-uuid-1");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].EnterpriseId, "enterprise-a");
  assert.equal(s.calls[0].LinkedReservationId, "reservation-a");
  assert.equal(s.calls[0].ProductOrders.length, 1);
  assert.equal(s.calls[0].ProductOrders[0].ProductId, "hotel-product-1");
  assert.equal(s.calls[0].ProductOrders[0].ExternalIdentifier, "veyra-addon:fixed-uuid-1");
  assert.equal(s.calls[0].Options.DisableItemGrouping, true);
  assert.equal(Object.hasOwn(s.calls[0].ProductOrders[0], "UnitAmount"), false, "Mews owns the configured product price");
  assert.equal(Object.hasOwn(s.calls[0], "Notes"), false, "no guest text is written into Mews notes");
  assert.equal(Object.hasOwn(s.state.claimInput, "accountId"), false, "guest account IDs are not stored in the idempotency record");
  assert.equal(s.state.completed.mewsOrderId, "mews-order-7");
});

test("returns a completed idempotent replay without calling Mews again", async () => {
  const expected = { status: "submitted_pending_readback", mewsOrderId: "mews-order-7" };
  const s = setup({ claim: async () => ({ status: "completed", result: expected }) });
  const result = await s.writer.addProductToReservation(s.input);
  assert.deepEqual(result, expected);
  assert.equal(s.calls.length, 0);
});

test("does not retry in-progress, uncertain or conflicting idempotency claims", async () => {
  for (const status of ["in_progress", "uncertain", "conflict"]) {
    const s = setup({ claim: async () => ({ status }) });
    await assert.rejects(s.writer.addProductToReservation(s.input), /already in progress|uncertain|different add-on/);
    assert.equal(s.calls.length, 0);
  }
});

test("marks an ambiguous provider timeout uncertain and never exposes the provider error", async () => {
  const s = setup({ addOrder: async () => { throw new Error("private token and raw provider response"); } });
  await assert.rejects(
    s.writer.addProductToReservation(s.input),
    error => error.message.includes("outcome is uncertain") && !error.message.includes("private token")
  );
  assert.equal(s.state.uncertain.reasonCode, "provider_outcome_unknown");
  assert.equal(s.calls.length, 1);
});

test("marks an invalid provider response uncertain instead of retrying", async () => {
  const s = setup({ addOrder: async () => ({}) });
  await assert.rejects(s.writer.addProductToReservation(s.input), /no verifiable OrderId/);
  assert.equal(s.state.uncertain.reasonCode, "provider_response_unverified");
});

test("marks local persistence failure uncertain with the returned Mews OrderId", async () => {
  const s = setup({ complete: async () => { throw new Error("database detail"); } });
  await assert.rejects(s.writer.addProductToReservation(s.input), /staff reconciliation is required/);
  assert.equal(s.state.uncertain.reasonCode, "local_commit_failed_after_provider_acceptance");
  assert.equal(s.state.uncertain.mewsOrderId, "mews-order-7");
});

test("rejects production clients, cross-tenant products and stale reservations before provider writes", async () => {
  const production = setup({ client: { tenantId: "tenant-a", environment: "production", writeEnabled: true, addOrder: async () => ({ OrderId: "x" }) } });
  await assert.rejects(production.writer.addProductToReservation(production.input), /restricted.*demo/);

  const crossTenant = setup();
  crossTenant.input.product.organizationId = "tenant-b";
  await assert.rejects(crossTenant.writer.addProductToReservation(crossTenant.input), /hotel-approved product/);
  assert.equal(crossTenant.calls.length, 0);

  const stale = setup();
  stale.input.reservation.fetchedAt = "2026-11-21T08:00:00.000Z";
  await assert.rejects(stale.writer.addProductToReservation(stale.input), /fresh, unexpired reservation/);
  assert.equal(stale.calls.length, 0);
});

test("requires a fresh verified demo connection and a confirmed or in-house reservation", async () => {
  const unverified = setup();
  unverified.input.connection.verified = false;
  await assert.rejects(unverified.writer.addProductToReservation(unverified.input), /verified tenant-specific/);

  const cancelled = setup();
  cancelled.input.reservation.state = "Canceled";
  await assert.rejects(cancelled.writer.addProductToReservation(cancelled.input), /confirmed or in-house reservation/);
});
