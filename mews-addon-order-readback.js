"use strict";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const EXTERNAL_ID = /^veyra-addon:[A-Za-z0-9._:-]{1,120}$/;
const SOURCE = "mews.orders.add+orderItems.getAll+productServiceOrders.getAll";

function required(value, field) {
  if (typeof value !== "string" || !SAFE_ID.test(value.trim())) throw new Error(field + " is invalid.");
  return value.trim();
}

function canonicalUtc(value, field) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value)) {
    throw new Error(field + " must be a canonical UTC timestamp.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(field + " must be a canonical UTC timestamp.");
  }
  return value;
}

function uniqueRows(rows, field, expectedEnterpriseId, enterpriseOptional = false) {
  if (!Array.isArray(rows)) throw new Error(field + " must be a complete array.");
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(field + " contains an invalid row.");
    const id = required(row.Id, field + ".Id");
    if (seen.has(id)) throw new Error(field + " contains duplicate IDs.");
    seen.add(id);
    if (row.EnterpriseId !== undefined && row.EnterpriseId !== expectedEnterpriseId) {
      throw new Error(field + " contains a different enterprise.");
    }
    if (!enterpriseOptional && row.EnterpriseId !== expectedEnterpriseId) {
      throw new Error(field + " contains a row without the expected enterprise.");
    }
  }
  return rows;
}

function resolveMewsAddonOrderReadback({
  organizationId,
  expectedEnterpriseId,
  writeRecord,
  orderItems,
  productServiceOrders,
  paginationComplete,
  verifiedAt
} = {}) {
  const organization = required(organizationId, "organizationId");
  const enterprise = required(expectedEnterpriseId, "expectedEnterpriseId");
  const readbackVerifiedAt = canonicalUtc(verifiedAt, "verifiedAt");
  const readbackVerifiedAtMs = Date.parse(readbackVerifiedAt);
  if (paginationComplete !== true) throw new Error("Complete order-item and product-service-order pagination is required.");
  if (!writeRecord || typeof writeRecord !== "object" || Array.isArray(writeRecord) ||
      writeRecord.organizationId !== organization || writeRecord.enterpriseId !== enterprise ||
      writeRecord.status !== "completed") {
    throw new Error("A completed server-owned tenant write record is required.");
  }
  const reservationId = required(writeRecord.reservationId, "writeRecord.reservationId");
  const serviceId = required(writeRecord.serviceId, "writeRecord.serviceId");
  const mewsOrderId = required(writeRecord.mewsOrderId, "writeRecord.mewsOrderId");
  const externalIdentifier = typeof writeRecord.externalIdentifier === "string" ? writeRecord.externalIdentifier.trim() : "";
  if (!EXTERNAL_ID.test(externalIdentifier)) throw new Error("A Veyra external identifier is required.");

  const items = uniqueRows(orderItems, "orderItems", enterprise);
  const serviceOrders = uniqueRows(productServiceOrders, "productServiceOrders", enterprise, true);
  const matches = items.filter(item => item.ExternalIdentifier === externalIdentifier);
  if (matches.length !== 1) throw new Error("The exact Veyra external identifier must resolve to one Mews order item.");
  const item = matches[0];
  if (item.EnterpriseId !== enterprise || item.ServiceId !== serviceId) {
    throw new Error("The Mews order item does not match the verified tenant service.");
  }
  const serviceOrderId = required(item.ServiceOrderId, "orderItem.ServiceOrderId");
  const linkedOrders = serviceOrders.filter(order => order.Id === serviceOrderId);
  if (linkedOrders.length !== 1) throw new Error("The order item's service order must resolve exactly once.");
  const serviceOrder = linkedOrders[0];
  const serviceOrderUpdatedAt = canonicalUtc(serviceOrder.UpdatedUtc, "productServiceOrder.UpdatedUtc");
  if (serviceOrder.ServiceId !== serviceId ||
      serviceOrder.LinkedReservationId !== reservationId ||
      !["Confirmed", "Started", "Processed"].includes(serviceOrder.State) ||
      (serviceOrder.CancelledUtc !== null && serviceOrder.CancelledUtc !== undefined) ||
      Date.parse(serviceOrderUpdatedAt) > readbackVerifiedAtMs) {
    throw new Error("The Mews service order does not verify the submitted reservation link and current state.");
  }

  return Object.freeze({
    organizationId: organization,
    enterpriseId: enterprise,
    mewsOrderId,
    serviceOrderId,
    reservationId,
    externalIdentifier,
    serviceOrderState: serviceOrder.State,
    serviceOrderUpdatedAt,
    serviceOrderCancelledAt: null,
    verifiedAt: readbackVerifiedAt,
    source: SOURCE
  });
}

module.exports = { resolveMewsAddonOrderReadback, SOURCE };
