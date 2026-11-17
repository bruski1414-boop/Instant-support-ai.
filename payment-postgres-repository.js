"use strict";

const crypto = require("node:crypto");

class PaymentRepositoryError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "PaymentRepositoryError";
    this.code = code;
    this.status = status;
  }
}

function createPaymentPostgresRepository({ pool } = {}) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("A PostgreSQL pool with query() and connect() is required.");
  }

  async function getBookingIntent({ organizationId, bookingIntentId }) {
    if (!organizationId || !bookingIntentId) return null;
    const result = await pool.query(
      `SELECT id,status,deposit_amount_minor,currency,idempotency_key,expires_at,
              payment_provider,payment_reference,checkout_url,checkout_expires_at
       FROM booking_intents
       WHERE organization_id=$1 AND id=$2`,
      [organizationId, bookingIntentId],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return Object.freeze({
      id: row.id,
      status: row.status,
      depositAmountMinor: Number(row.deposit_amount_minor),
      currency: String(row.currency).trim(),
      idempotencyKey: row.idempotency_key,
      expiresAt: new Date(row.expires_at),
      paymentProvider: row.payment_provider,
      paymentProviderReference: row.payment_reference,
      checkoutUrl: row.checkout_url,
      checkoutExpiresAt: row.checkout_expires_at ? new Date(row.checkout_expires_at) : null,
    });
  }

  async function saveCheckout({
    organizationId, bookingIntentId, provider, providerReference, checkoutUrl,
    checkoutExpiresAt, expectedAmountMinor, expectedCurrency,
  }) {
    if (!organizationId || !bookingIntentId || !provider || !providerReference ||
        !checkoutUrl || !Number.isSafeInteger(expectedAmountMinor) ||
        !/^[A-Z]{3}$/.test(expectedCurrency || "")) {
      throw new PaymentRepositoryError("INVALID_CHECKOUT_RECORD", "Checkout details are incomplete.");
    }
    const result = await pool.query(
      `UPDATE booking_intents
       SET payment_provider=$3,payment_reference=$4,checkout_url=$5,
           checkout_expires_at=$6,updated_at=now()
       WHERE organization_id=$1 AND id=$2 AND status='awaiting_payment'
         AND expires_at>now() AND deposit_amount_minor=$7 AND currency=$8
         AND (payment_provider IS NULL OR payment_provider=$3)
         AND (payment_reference IS NULL OR payment_reference=$4)
       RETURNING id`,
      [organizationId, bookingIntentId, provider, providerReference, checkoutUrl,
        checkoutExpiresAt, expectedAmountMinor, expectedCurrency],
    );
    if (result.rowCount) return Object.freeze({ saved: true });
    const existing = await getBookingIntent({ organizationId, bookingIntentId });
    if (existing && existing.paymentProvider === provider &&
        existing.paymentProviderReference === providerReference &&
        existing.checkoutUrl === checkoutUrl) {
      return Object.freeze({ saved: true, reused: true });
    }
    throw new PaymentRepositoryError("CHECKOUT_STATE_CONFLICT", "The booking changed before checkout could be saved. Staff review is required.");
  }

  async function applyVerifiedPaymentEvent({ provider, event }) {
    if (!provider || !event || event.signatureVerified !== true ||
        !event.eventId || !event.bookingIntentId || !event.providerReference ||
        !Number.isSafeInteger(event.amountMinor) || event.amountMinor <= 0 ||
        !/^[A-Z]{3}$/.test(event.currency || "") ||
        !["succeeded", "failed", "cancelled", "pending"].includes(event.paymentStatus)) {
      throw new PaymentRepositoryError("INVALID_VERIFIED_EVENT", "A complete verified payment event is required.", 400);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        `SELECT id,organization_id,status,payment_provider,payment_reference,
                deposit_amount_minor,currency,expires_at
         FROM booking_intents WHERE id=$1 FOR UPDATE`,
        [event.bookingIntentId],
      );
      const row = found.rows[0] || null;
      const matches = row &&
        row.payment_provider === provider &&
        row.payment_reference === event.providerReference &&
        Number(row.deposit_amount_minor) === event.amountMinor &&
        String(row.currency).trim() === event.currency;

      const resultStatus = !row ? "ignored" :
        (!matches || row.status !== "awaiting_payment" || new Date(row.expires_at).getTime() <= Date.now())
          ? "manual_review"
          : event.paymentStatus === "pending" ? "ignored" : "recorded";

      const inserted = await client.query(
        `INSERT INTO payment_provider_events
           (provider,provider_event_id,booking_intent_id,event_type,payment_status,
            amount_minor,currency,payload_sha256,result_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(provider,provider_event_id) DO NOTHING
         RETURNING id`,
        [provider,event.eventId,row?.id || null,event.eventType,event.paymentStatus,
          event.amountMinor,event.currency,
          crypto.createHash("sha256").update([
            event.eventId,event.eventType,event.paymentStatus,event.providerReference,
            event.bookingIntentId,event.amountMinor,event.currency,
          ].join("|")).digest("hex"),resultStatus],
      );
      if (!inserted.rowCount) {
        await client.query("COMMIT");
        return Object.freeze({ status: "duplicate" });
      }

      if (row && resultStatus === "manual_review") {
        await client.query(
          `UPDATE booking_intents SET status='requires_manual_review',updated_at=now()
           WHERE id=$1 AND status IN ('awaiting_payment','deposit_paid')`,
          [row.id],
        );
      } else if (row && resultStatus === "recorded" && event.paymentStatus === "succeeded") {
        await client.query(
          `UPDATE booking_intents SET status='deposit_paid',updated_at=now()
           WHERE id=$1 AND status='awaiting_payment'`,
          [row.id],
        );
      } else if (row && resultStatus === "recorded" &&
                 ["failed","cancelled"].includes(event.paymentStatus)) {
        await client.query(
          `UPDATE booking_intents SET status='failed',updated_at=now()
           WHERE id=$1 AND status='awaiting_payment'`,
          [row.id],
        );
      }
      await client.query("COMMIT");
      return Object.freeze({ status: resultStatus });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ getBookingIntent, saveCheckout, applyVerifiedPaymentEvent });
}

module.exports = { PaymentRepositoryError, createPaymentPostgresRepository };
