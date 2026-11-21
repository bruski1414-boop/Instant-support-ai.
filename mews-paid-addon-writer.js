"use strict";

const { createHash, randomUUID } = require("node:crypto");

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const EXTERNAL_ID = /^veyra-addon:[A-Za-z0-9._:-]{1,120}$/;
const MAX_RESERVATION_AGE_MS = 5 * 60 * 1000;
const MAX_CONNECTION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function required(value, field) {
  if (typeof value !== "string" || !SAFE_ID.test(value.trim())) throw new Error(field + " is invalid.");
  return value.trim();
}

function utcMillis(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error(field + " must be a canonical UTC timestamp.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(field + " must be a canonical UTC timestamp.");
  }
  return parsed;
}

function requestHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createMewsPaidAddonWriter({ client, idempotencyStore, now = () => Date.now(), idFactory = randomUUID } = {}) {
  if (!client || typeof client.addOrder !== "function" || !idempotencyStore ||
      !["claim", "complete", "markUncertain"].every(name => typeof idempotencyStore[name] === "function")) {
    throw new Error("A Mews demo client and durable idempotency store are required.");
  }
  if (typeof now !== "function" || typeof idFactory !== "function") throw new Error("Clock and identifier functions are required.");

  async function addProductToReservation(input = {}) {
    const organizationId = required(input.organizationId, "organizationId");
    if (client.tenantId !== organizationId || client.environment !== "demo" || client.writeEnabled !== true) {
      throw new Error("Mews add-on writes are restricted to the verified tenant's demo connection.");
    }

    const connection = input.connection;
    if (!connection || connection.organizationId !== organizationId || connection.environment !== "demo" ||
        connection.status !== "connected" || connection.verified !== true) {
      throw new Error("A verified tenant-specific Mews demo connection is required.");
    }
    const nowMs = now();
    const connectionVerifiedAt = utcMillis(connection.verifiedAt, "connection.verifiedAt");
    if (connectionVerifiedAt > nowMs || nowMs - connectionVerifiedAt > MAX_CONNECTION_AGE_MS) {
      throw new Error("The Mews demo connection verification is stale.");
    }

    const product = input.product;
    if (!product || product.organizationId !== organizationId || product.enterpriseId !== connection.enterpriseId ||
        product.approved !== true || product.active !== true) {
      throw new Error("An active, hotel-approved product from this Mews enterprise is required.");
    }
    const enterpriseId = required(connection.enterpriseId, "enterpriseId");
    const serviceId = required(product.serviceId, "product.serviceId");
    const productId = required(product.productId, "product.productId");

    const reservation = input.reservation;
    if (!reservation || reservation.organizationId !== organizationId || reservation.enterpriseId !== enterpriseId ||
        !["Confirmed", "Started"].includes(reservation.state)) {
      throw new Error("A confirmed or in-house reservation from this tenant and enterprise is required.");
    }
    const reservationId = required(reservation.id, "reservation.id");
    const accountId = required(reservation.accountId, "reservation.accountId");
    const fetchedAt = utcMillis(reservation.fetchedAt, "reservation.fetchedAt");
    const validUntil = utcMillis(reservation.validUntil, "reservation.validUntil");
    if (fetchedAt > nowMs || nowMs - fetchedAt > MAX_RESERVATION_AGE_MS ||
        validUntil <= nowMs || validUntil <= fetchedAt || validUntil - fetchedAt > 15 * 60 * 1000) {
      throw new Error("A fresh, unexpired reservation read is required before adding an item.");
    }

    const count = input.count === undefined ? 1 : input.count;
    if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error("Product count must be an integer from 1 to 20.");
    const idempotencyKey = required(input.idempotencyKey, "idempotencyKey");
    if (idempotencyKey.length > 100) throw new Error("idempotencyKey is too long.");

    const hash = requestHash({
      organizationId,
      enterpriseId,
      serviceId,
      productId,
      reservationId,
      accountId,
      count
    });
    const generated = required(idFactory(), "generated identifier");
    const externalIdentifier = "veyra-addon:" + generated;
    if (!EXTERNAL_ID.test(externalIdentifier)) throw new Error("Generated external identifier is invalid.");

    const claim = await idempotencyStore.claim({
      organizationId,
      idempotencyKey,
      requestHash: hash,
      enterpriseId,
      serviceId,
      reservationId,
      externalIdentifier
    });
    if (claim?.status === "completed" && claim.result) return claim.result;
    if (claim?.status !== "acquired") {
      const message = claim?.status === "uncertain"
        ? "The previous Mews write outcome is uncertain; reconcile it before any retry."
        : claim?.status === "in_progress"
          ? "The Mews write is already in progress; do not submit it again."
          : claim?.status === "conflict"
            ? "This idempotency key was already used for a different add-on request."
            : "The Mews write cannot safely be started.";
      const error = new Error(message);
      error.code = "MEWS_ADDON_WRITE_NOT_ACQUIRED";
      throw error;
    }

    const payload = {
      EnterpriseId: enterpriseId,
      ServiceId: serviceId,
      AccountId: accountId,
      Options: { DisableItemGrouping: true },
      ProductOrders: [{
        ProductId: productId,
        Count: count,
        ExternalIdentifier: claim.externalIdentifier
      }],
      LinkedReservationId: reservationId
    };

    let response;
    try {
      response = await client.addOrder(payload);
    } catch {
      await idempotencyStore.markUncertain({
        organizationId, idempotencyKey, requestHash: hash, reasonCode: "provider_outcome_unknown"
      }).catch(() => {});
      throw new Error("Mews add-on write outcome is uncertain; staff reconciliation is required before retrying.");
    }

    const orderId = response && typeof response.OrderId === "string" && SAFE_ID.test(response.OrderId.trim())
      ? response.OrderId.trim() : null;
    if (!orderId) {
      await idempotencyStore.markUncertain({
        organizationId, idempotencyKey, requestHash: hash, reasonCode: "provider_response_unverified"
      }).catch(() => {});
      throw new Error("Mews returned no verifiable OrderId; staff reconciliation is required before retrying.");
    }

    const result = Object.freeze({
      status: "submitted_pending_readback",
      organizationId,
      enterpriseId,
      serviceId,
      productId,
      reservationId,
      externalIdentifier: claim.externalIdentifier,
      mewsOrderId: orderId,
      count,
      submittedAt: new Date(now()).toISOString()
    });
    try {
      await idempotencyStore.complete({
        organizationId, idempotencyKey, requestHash: hash, mewsOrderId: orderId, result
      });
    } catch {
      await idempotencyStore.markUncertain({
        organizationId, idempotencyKey, requestHash: hash,
        reasonCode: "local_commit_failed_after_provider_acceptance",
        mewsOrderId: orderId
      }).catch(() => {});
      throw new Error("Mews may have accepted the add-on but Veyra could not commit its record; staff reconciliation is required.");
    }
    return result;
  }

  return Object.freeze({ addProductToReservation });
}

module.exports = { createMewsPaidAddonWriter, requestHash };
