"use strict";

const {
  hashBookingAttributionToken,
  issueBookingAttributionIntent,
  isVerifiedReservationEvidence,
  matchConfirmedReservationToBookingIntent
} = require("./booking-attribution");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredOrganizationId(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("organizationId must be a valid UUID.");
  }
  return value.toLowerCase();
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function createBookingAttributionStore({ pool } = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new Error("A PostgreSQL pool is required for booking attribution persistence.");
  }

  async function issueIntent({ organizationId, conversationId, issuedAt, ttlMs, tokenFactory } = {}) {
    const issued = issueBookingAttributionIntent({ organizationId, conversationId, issuedAt, ttlMs, tokenFactory });
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const conversation = await client.query(
        "SELECT id FROM conversations WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [issued.record.conversationId, issued.record.organizationId]
      );
      if (!conversation.rowCount) throw new Error("Conversation not found in this hotel workspace.");

      const revoked = await client.query(
        "UPDATE booking_attribution_intents SET revoked_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id",
        [issued.record.organizationId, issued.record.conversationId]
      );
      if (revoked.rowCount) {
        await client.query(
          "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id) VALUES($1,NULL,'booking_attribution.intent_revoked','conversation',$2)",
          [issued.record.organizationId, issued.record.conversationId]
        );
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

  async function consumeConfirmedReservation({ organizationId, verifiedEvidence } = {}) {
    const safeOrganizationId = requiredOrganizationId(organizationId);
    if (!isVerifiedReservationEvidence(verifiedEvidence)) {
      throw new Error("A provider-verified reservation evidence object is required.");
    }
    const tokenHash = hashBookingAttributionToken(verifiedEvidence.attributionToken);
    const client = await pool.connect();
    let transactionOpen = false;
    let intentId = null;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const found = await client.query(
        "SELECT id,organization_id,conversation_id,token_hash,issued_at,expires_at,consumed_at,revoked_at,provider,provider_event_id,reservation_id FROM booking_attribution_intents WHERE organization_id=$1 AND token_hash=$2 FOR UPDATE",
        [safeOrganizationId, tokenHash]
      );
      if (!found.rowCount) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return Object.freeze({ status: "unmatched" });
      }

      const row = found.rows[0];
      intentId = row.id;
      if (row.revoked_at) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return Object.freeze({ status: "unmatched" });
      }
      if (row.consumed_at) {
        const sameEvent = row.provider === verifiedEvidence.provider &&
          (row.provider_event_id === verifiedEvidence.eventId || row.reservation_id === verifiedEvidence.reservationId);
        await client.query("ROLLBACK");
        transactionOpen = false;
        return Object.freeze({ status: sameEvent ? "duplicate" : "already_consumed" });
      }

      const match = matchConfirmedReservationToBookingIntent({
        organizationId: safeOrganizationId,
        verifiedEvidence,
        attributionIntent: {
          organizationId: row.organization_id,
          conversationId: row.conversation_id,
          tokenHash: row.token_hash,
          issuedAt: iso(row.issued_at),
          expiresAt: iso(row.expires_at),
          consumedAt: null,
          revokedAt: null
        }
      });
      if (!match) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return Object.freeze({ status: "unmatched" });
      }

      const inserted = await client.query(
        "INSERT INTO booking_attribution_matches(organization_id,intent_id,conversation_id,provider,provider_event_id,reservation_id,occurred_at,booking_value_minor,currency,match_method,verification_method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
        [
          safeOrganizationId,
          row.id,
          row.conversation_id,
          match.provider,
          match.providerEventId,
          match.reservationId,
          match.occurredAt,
          match.bookingValue?.amountMinor ?? null,
          match.bookingValue?.currency ?? null,
          match.matchMethod,
          match.verificationMethod
        ]
      );
      await client.query(
        "INSERT INTO booking_reservation_lifecycle_events(organization_id,provider,provider_event_id,reservation_id,status,occurred_at,verification_method) VALUES($1,$2,$3,$4,'confirmed',$5,$6)",
        [safeOrganizationId, match.provider, match.providerEventId, match.reservationId, match.occurredAt, match.verificationMethod]
      );
      const consumed = await client.query(
        "UPDATE booking_attribution_intents SET consumed_at=now(),provider=$3,provider_event_id=$4,reservation_id=$5 WHERE id=$1 AND organization_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL",
        [row.id, safeOrganizationId, match.provider, match.providerEventId, match.reservationId]
      );
      if (consumed.rowCount !== 1) throw new Error("Booking attribution intent could not be consumed exactly once.");
      await client.query(
        "INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type,target_id) VALUES($1,NULL,'booking_attribution.reservation_matched','booking_attribution_match',$2)",
        [safeOrganizationId, inserted.rows[0].id]
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return Object.freeze({ status: "matched", match: Object.freeze({ ...match, id: inserted.rows[0].id }) });
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
      if (error?.code === "23505") {
        const existing = await pool.query(
          "SELECT intent_id,provider_event_id,reservation_id FROM booking_attribution_matches WHERE organization_id=$1 AND provider=$2 AND (provider_event_id=$3 OR reservation_id=$4) ORDER BY created_at ASC LIMIT 1",
          [safeOrganizationId, verifiedEvidence.provider, verifiedEvidence.eventId, verifiedEvidence.reservationId]
        );
        if (existing.rowCount) {
          if (existing.rows[0].intent_id === intentId) return Object.freeze({ status: "duplicate" });
          if (existing.rows[0].reservation_id === verifiedEvidence.reservationId) {
            return Object.freeze({ status: "reservation_already_linked" });
          }
          return Object.freeze({ status: "provider_event_id_collision" });
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ issueIntent, consumeConfirmedReservation });
}

module.exports = { createBookingAttributionStore };
