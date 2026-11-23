"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectMewsCursorPages,
  isCompleteMewsPageCollection
} = require("../mews-cursor-pagination");
const { mapMewsPaidAddonEvidenceFromPageCollections } = require("../mews-paid-addon-adapter");
const { resolveMewsAddonOrderReadbackFromPageCollections } = require("../mews-addon-order-readback");
const { createValidMewsAccountingFixture } = require("../fixtures/mews-paid-addon-accounting");

function pageResponses(collectionKey, rows, pageSize) {
  const pages = [];
  for (let index = 0; index < rows.length; index += pageSize) {
    const batch = rows.slice(index, index + pageSize);
    pages.push({ [collectionKey]: batch, Cursor: batch[batch.length - 1].Id });
  }
  pages.push({ [collectionKey]: [], Cursor: null });
  return pages;
}

async function collectRows(collectionKey, rows, pageSize = 1) {
  const pages = pageResponses(collectionKey, rows, pageSize);
  let index = 0;
  let expectedCursor = null;
  const collection = await collectMewsCursorPages({
    collectionKey,
    pageSize,
    fetchPage: async request => {
      assert.equal(request.cursor, expectedCursor);
      assert.equal(request.count, pageSize);
      const page = pages[index++];
      assert.ok(page, "collector must not request pages after the terminal response");
      expectedCursor = page.Cursor;
      return page;
    }
  });
  assert.equal(index, pages.length);
  return collection;
}

test("follows Mews cursors until the explicit empty terminal page", async () => {
  const requests = [];
  const pages = [
    { OrderItems: [{ Id: "item-1" }], Cursor: "item-1" },
    { OrderItems: [{ Id: "item-2" }], Cursor: "item-2" },
    { OrderItems: [], Cursor: null }
  ];
  const collection = await collectMewsCursorPages({
    collectionKey: "OrderItems",
    pageSize: 1,
    fetchPage: async request => {
      requests.push(request);
      return pages[requests.length - 1];
    }
  });

  assert.deepEqual(requests.map(item => item.cursor), [null, "item-1", "item-2"]);
  assert.deepEqual(collection.items.map(item => item.Id), ["item-1", "item-2"]);
  assert.equal(collection.pageCount, 3);
  assert.equal(collection.recordCount, 2);
  assert.equal(isCompleteMewsPageCollection(collection, "OrderItems"), true);
  assert.equal(isCompleteMewsPageCollection(collection, "Bills"), false);
  assert.equal(Object.isFrozen(collection.items[0]), true);
  assert.throws(() => { collection.items[0].Id = "tampered"; }, TypeError);
});

test("accepts a genuinely empty collection only with a null terminal cursor", async () => {
  const collection = await collectMewsCursorPages({
    collectionKey: "Bills",
    fetchPage: async () => ({ Bills: [], Cursor: null })
  });
  assert.deepEqual(collection.items, []);
  assert.equal(collection.pageCount, 1);
  assert.equal(isCompleteMewsPageCollection(collection, "Bills"), true);
});

test("rejects a missing Cursor field even when the response contains an array", async () => {
  await assert.rejects(
    collectMewsCursorPages({
      collectionKey: "Payments",
      fetchPage: async () => ({ Payments: [] })
    }),
    /incomplete cursor page/
  );
});

test("rejects a cursor that does not identify the last returned record", async () => {
  await assert.rejects(
    collectMewsCursorPages({
      collectionKey: "Bills",
      fetchPage: async () => ({ Bills: [{ Id: "bill-1" }], Cursor: "different-bill" })
    }),
    /did not identify the last record/
  );
});

test("rejects duplicate identifiers across pages rather than silently deduplicating", async () => {
  const pages = [
    { Payments: [{ Id: "payment-1" }], Cursor: "payment-1" },
    { Payments: [{ Id: "payment-1" }], Cursor: "payment-1" }
  ];
  let index = 0;
  await assert.rejects(
    collectMewsCursorPages({
      collectionKey: "Payments",
      pageSize: 1,
      fetchPage: async () => pages[index++]
    }),
    /duplicate record identifier/
  );
});

test("rejects malformed rows, unsafe cursors and oversized pages", async () => {
  await assert.rejects(
    collectMewsCursorPages({
      collectionKey: "OrderItems",
      fetchPage: async () => ({ OrderItems: [{ Id: "contains spaces" }], Cursor: "contains spaces" })
    }),
    /valid opaque identifier/
  );
  await assert.rejects(
    collectMewsCursorPages({
      collectionKey: "OrderItems",
      fetchPage: async () => ({ OrderItems: [], Cursor: "unsafe cursor" })
    }),
    /invalid pagination cursor/
  );
  await assert.rejects(
    collectMewsCursorPages({
      collectionKey: "OrderItems",
      pageSize: 1,
      fetchPage: async () => ({ OrderItems: [{ Id: "one" }, { Id: "two" }], Cursor: "two" })
    }),
    /more records than the requested page size/
  );
});

test("fails closed when the page or record safety bound is exceeded", async () => {
  let page = 0;
  await assert.rejects(
    collectMewsCursorPages({
      collectionKey: "Bills",
      pageSize: 1,
      maxPages: 1,
      fetchPage: async () => {
        page += 1;
        return { Bills: [{ Id: "bill-" + page }], Cursor: "bill-" + page };
      }
    }),
    /page safety limit/
  );

  await assert.rejects(
    collectMewsCursorPages({
      collectionKey: "Bills",
      pageSize: 2,
      maxRecords: 1,
      fetchPage: async () => ({ Bills: [{ Id: "bill-1" }, { Id: "bill-2" }], Cursor: "bill-2" })
    }),
    /record safety limit/
  );
});

test("does not leak provider error text from a failed page request", async () => {
  await assert.rejects(
    collectMewsCursorPages({
      collectionKey: "Payments",
      fetchPage: async () => { throw new Error("access-token-secret"); }
    }),
    error => {
      assert.match(error.message, /request failed/);
      assert.equal(error.message.includes("access-token-secret"), false);
      return true;
    }
  );
});

test("rejects forged completion objects and raw arrays", () => {
  assert.equal(isCompleteMewsPageCollection({ collectionKey: "OrderItems", items: [], complete: true }), false);
  assert.equal(isCompleteMewsPageCollection([], "OrderItems"), false);
});

test("passes only branded complete pages to the paid add-on evidence mapper", async () => {
  const fixture = createValidMewsAccountingFixture();
  const [orderItemsCollection, billsCollection, paymentsCollection] = await Promise.all([
    collectRows("OrderItems", fixture.orderItems, 1),
    collectRows("Bills", fixture.bills, 1),
    collectRows("Payments", fixture.payments, 1)
  ]);
  const result = mapMewsPaidAddonEvidenceFromPageCollections({
    ...fixture,
    paginationComplete: false,
    orderItemsCollection,
    billsCollection,
    paymentsCollection
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].attributionStatus, "hotel_reported_unlinked");
  assert.equal(result.events[0].grossAmountMinor, 12500);
  assert.equal("conversationId" in result.events[0], false);
});

test("paid add-on mapper wrapper rejects caller-created completion flags", () => {
  const fixture = createValidMewsAccountingFixture();
  assert.throws(
    () => mapMewsPaidAddonEvidenceFromPageCollections({
      ...fixture,
      orderItemsCollection: { collectionKey: "OrderItems", items: fixture.orderItems, complete: true },
      billsCollection: { collectionKey: "Bills", items: fixture.bills, complete: true },
      paymentsCollection: { collectionKey: "Payments", items: fixture.payments, complete: true }
    }),
    /validated, complete Mews cursor collections/
  );
});

test("readback proof requires branded complete order-item and product-service-order pages", async () => {
  const fixture = createValidMewsAccountingFixture();
  const serviceOrders = [{
    Id: "service-order-44",
    EnterpriseId: "enterprise-demo-a",
    ServiceId: "service-spa",
    LinkedReservationId: "reservation-22",
    State: "Confirmed",
    CancelledUtc: null,
    UpdatedUtc: "2026-11-20T08:59:00.000Z"
  }];
  const [orderItemsCollection, productServiceOrdersCollection] = await Promise.all([
    collectRows("OrderItems", fixture.orderItems, 1),
    collectRows("ProductServiceOrders", serviceOrders, 1)
  ]);
  const proof = resolveMewsAddonOrderReadbackFromPageCollections({
    organizationId: fixture.organizationId,
    expectedEnterpriseId: fixture.expectedEnterpriseId,
    writeRecord: {
      ...fixture.verifiedOrderItemWrites[0],
      status: "completed",
      serviceId: "service-spa"
    },
    orderItemsCollection,
    productServiceOrdersCollection,
    verifiedAt: "2026-11-20T09:00:00.000Z"
  });

  assert.equal(proof.serviceOrderId, "service-order-44");
  assert.equal(proof.reservationId, "reservation-22");
  assert.equal(proof.source, "mews.orders.add+orderItems.getAll+productServiceOrders.getAll");
});

test("readback proof rejects unbranded arrays and caller-supplied pagination booleans", () => {
  assert.throws(
    () => resolveMewsAddonOrderReadbackFromPageCollections({
      organizationId: "hotel-demo-tenant-a",
      expectedEnterpriseId: "enterprise-demo-a",
      writeRecord: { status: "completed" },
      orderItemsCollection: { collectionKey: "OrderItems", items: [], complete: true },
      productServiceOrdersCollection: { collectionKey: "ProductServiceOrders", items: [], complete: true },
      paginationComplete: true,
      verifiedAt: "2026-11-20T09:00:00.000Z"
    }),
    /validated, complete Mews cursor collections/
  );
});
