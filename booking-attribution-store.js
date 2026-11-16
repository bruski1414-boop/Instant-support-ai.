"use strict";

const {
  hashBookingAttributionToken,
  issueBookingAttributionIntent,
  matchConfirmedReservationToBookingIntent
} = require("./booking-attribution");
const { normalizeReservationEvent } = require("./pms-integration");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredOrganizationId(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("organizationId must be a valid UUID.");
  }
  return value.toLowerCase();
}

function requiredProvider(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 80 ||
      value.split("").some(ch => ch.charCodeAt(0) < 32)) {
    throw new Error("A trusted PMS adapter provider name is required.");
  }
  return value.trim();
}

function createBookingAttributionStore({ pool } = {}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("A PostgreSQL pool is required for booking attribution persistence.");
  }

  async function issueIntent({ organizationId, conversationId, issuedAt, ttlMs } = {}) {
    const issued = issueBookingAttributionIntent({ organizationId, conversationId, issuedAt, ttlMs });
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const conversation = await client.query(
        "SELECT id FROM conversations WHERE id=$1 AND organization_id=$2 FOR SHARE",
        [issued.record.conversationId, issued.record.organizationId]
      );
      if (!conversation.rowCount) {
        throw new Error("Conversation not found in this hotel workspace.");
      }

      const inserted = await client.query(
        "INSERT INTO booking_attribution_intents(organization_id,conversation_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [
          issued.record.organizationId,
          issued.record.conversationId,
          issued.record.tokenHash,
          issued.record.issuedAt,
          issued.record.expiresAt
        ]
      );
      await client.query(
        "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id) VALUES($1,NULL,'booking_attribution.intent_issued','booking_attribution_intent',$2)",
        [issued.record.organizationId, inserted.rows[0].id]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return Object.freeze({
        intentId: inserted.rows[0].id,
        oneTimeToken: issued.oneTimeToken,
        issuedAt: issued.record.issuedAt,
        expiresAt: issued.record.expiresAt
      });
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function consumeConfirmedReservation({ organizationId, reservationEvent } = {}) {
    const safeOrganizationId = requiredOrganizationId(organizationId);
    const provider = requiredProvider(reservationEvent?.provider);
    const normalized = normalizeReservationEvent(reservationEvent);
    const event = Object.freeze({ ...normalized, provider });

    if (!["reservation.created", "reservation.updated"].includes(event.eventType) ||
        event.status !== "confirmed" || !event.attributionToken) {
      return Object.freeze({ status: "unmatched" });
    }

    const tokenHash = hashBookingAttributionToken(event.attributionToken);
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const found = await client.query(
        "SELECT id,organization_id,conversation_id,token_hash,issued_at,expires_at,consumed_at,provider,provider_event_id,reservation_id FROM booking_attribution_intents WHERE organization_id=$1 AND token_hash=$2 FOR UPDATE",
        [safeOrganizationId, tokenHash]
      );
      if (!found.rowCount) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return Object.freeze({ status: "unmatched" });
      }

      const intent = found.rows[0];
      if (intent.consumed_at) {
        const sameEvent = intent.provider === provider &&
          (intent.provider_event_id === event.eventId || intent.reservation_id === event.reservationId);
        await client.query("ROLLBACK");
        transactionOpen = false;
        return Object.freeze({ status: sameEvent ? "duplicate" : "already_consumed" });
      }
      if (!intent.conversation_id) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return Object.freeze({ status: "unmatched" });
      }

      const match = matchConfirmedReservationToBookingIntent({
        organizationId: safeOrganizationId,
        reservationEvent: event,
        attributionIntent: {
          organizationId: intent.organization_id,
          conversationId: intent.conversation_id,
          tokenHash: intent.token_hash,
          issuedAt: new Date(intent.issued_at).toISOString(),
          expiresAt: new Date(intent.expires_at).toISOString(),
          consumedAt: null
        }
      });
      if (!match) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return Object.freeze({ status: "unmatched" });
      }

      const inserted = await client.query(
        "INSERT INTO booking_attribution_matches(organization_id,intent_id,conversation_id,provider,provider_event_id,reservation_id,occurred_at,booking_value_minor,currency,match_method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
        [
          safeOrganizationId,
          intent.id,
          intent.conversation_id,
          provider,
          event.eventId,
          event.reservationId,
          event.occurredAt,
          match.bookingValue?.amountMinor ?? null,
          match.bookingValue?.currency ?? null,
          match.matchMethod
        ]
      );
      const consumed = await client.query(
        "UPDATE booking_attribution_intents SET consumed_at=$3,provider=$4,provider_event_id=$5,reservation_id=$6 WHERE id=$1 AND organization_id=$2 AND consumed_at IS NULL",
        [intent.id, safeOrganizationId, event.occurredAt, provider, event.eventId, event.reservationId]
      );
      if (consumed.rowCount !== 1) {
        throw new Error("Booking attribution intent could not be consumed exactly once.");
      }
      await client.query(
        "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id) VALUES($1,NULL,'booking_attribution.reservation_matched','booking_attribution_match',$2)",
        [safeOrganizationId, inserted.rows[0].id]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return Object.freeze({
        status: "matched",
        match: Object.freeze({ ...match, id: inserted.rows[0].id })
      });
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
      if (error?.code === "23505") return Object.freeze({ status: "duplicate" });
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ issueIntent, consumeConfirmedReservation });
}

module.exports = { createBookingAttributionStore };
