"use strict";

const crypto = require("node:crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const EXTERNAL_ID = /^veyra-addon:[A-Za-z0-9._:-]{1,120}$/;
const HASH = /^[a-f0-9]{64}$/;

function requiredId(value, field) {
  if (typeof value !== "string" || !SAFE_ID.test(value.trim())) {
    throw new Error(field + " must be a valid opaque identifier.");
  }
  return value.trim();
}

function organizationUuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("organizationId must be a valid tenant UUID.");
  }
  return value.toLowerCase();
}

function positiveMinor(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(field + " must be a positive integer in minor currency units.");
  }
  return value;
}

function currencyCode(value) {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw new Error("currency must be an uppercase ISO 4217 code.");
  }
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: value });
  } catch {
    throw new Error("currency must be a supported ISO 4217 code.");
  }
  return value;
}

function canonicalUtc(value, field) {
  if (typeof value !== "string") throw new Error(field + " must be a canonical UTC timestamp.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(field + " must be a canonical UTC timestamp.");
  }
  return value;
}

/**
 * Validate and minimize the mapper output before it enters durable storage.
 * V1 stores only fully paid, unadjusted, unlinked Mews add-ons. Refunds and
 * chargebacks require a separate item-allocation proof and are not accepted.
 */
function normalizePaidAddonLedgerEvent(event, organizationId) {
  const tenant = organizationUuid(organizationId);
  if (!event || typeof event !== "object" || Array.isArray(event) || event.organizationId !== tenant) {
    throw new Error("Paid add-on event must belong to the authenticated tenant.");
  }
  if (event.conversationId !== undefined && event.conversationId !== null) {
    throw new Error("Provider paid add-on events remain unlinked until a separate authorized attribution proof exists.");
  }
  if (event.provider !== "mews" || event.type !== "addon_paid" || event.status !== "paid_addon_verified") {
    throw new Error("Only reconciled Mews paid add-on evidence can enter this ledger.");
  }

  const externalReference = requiredId(event.externalReference, "externalReference");
  const sourceReference = requiredId(event.sourceReference, "sourceReference");
  const reservationId = requiredId(event.reservationId, "reservationId");
  const externalIdentifier = typeof event.externalIdentifier === "string" ? event.externalIdentifier.trim() : "";
  if (!EXTERNAL_ID.test(externalIdentifier)) throw new Error("A Veyra-issued external identifier is required.");

  const grossAmountMinor = positiveMinor(event.grossAmountMinor, "grossAmountMinor");
  const adjustmentAmountMinor = event.adjustmentAmountMinor;
  const amountMinor = event.amountMinor;
  if (adjustmentAmountMinor !== 0 || amountMinor !== grossAmountMinor) {
    throw new Error("V1 ledger ingestion accepts only unadjusted paid add-ons; refunds and chargebacks need item-allocation proof.");
  }
  const currency = currencyCode(event.currency);
  const occurredAt = canonicalUtc(event.occurredAt, "occurredAt");

  const evidence = event.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
      evidence.billType !== "Receipt" || evidence.billId !== sourceReference ||
      !Array.isArray(evidence.chargedPaymentIds) || evidence.chargedPaymentIds.length < 1 ||
      evidence.chargedPaymentIds.length > 100 ||
      !Array.isArray(evidence.adjustmentReferences) || evidence.adjustmentReferences.length !== 0) {
    throw new Error("A closed Receipt, linked Charged payment evidence and no unresolved adjustments are required.");
  }
  const chargedPaymentIds = evidence.chargedPaymentIds.map((id, index) =>
    requiredId(id, "chargedPaymentIds[" + index + "]")
  );
  if (new Set(chargedPaymentIds).size !== chargedPaymentIds.length) {
    throw new Error("Charged payment evidence identifiers must be unique.");
  }

  // Construct an allowlisted record. Guest names, account data, notes, card
  // details, conversation IDs and arbitrary provider fields are never copied.
  return Object.freeze({
    organizationId: tenant,
    provider: "mews",
    externalReference,
    externalIdentifier,
    sourceReference,
    reservationId,
    grossAmountMinor,
    adjustmentAmountMinor: 0,
    amountMinor: grossAmountMinor,
    currency,
    occurredAt,
    attributionStatus: "hotel_reported_unlinked",
    evidence: Object.freeze({
      billType: "Receipt",
      billId: sourceReference,
      chargedPaymentIds: Object.freeze([...chargedPaymentIds].sort()),
      adjustmentReferences: Object.freeze([])
    })
  });
}

function evidenceHash(event) {
  return crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS paid_addon_ledger_events (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'mews'),
  external_reference TEXT NOT NULL CHECK (length(external_reference) BETWEEN 1 AND 200),
  external_identifier TEXT NOT NULL CHECK (external_identifier ~ '^veyra-addon:[A-Za-z0-9._:-]{1,120}$'),
  source_reference TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  gross_amount_minor BIGINT NOT NULL CHECK (gross_amount_minor > 0),
  adjustment_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (adjustment_amount_minor = 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor = gross_amount_minor),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  attribution_status TEXT NOT NULL CHECK (attribution_status = 'hotel_reported_unlinked'),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, provider, external_reference),
  UNIQUE (organization_id, provider, external_identifier)
);
CREATE INDEX IF NOT EXISTS paid_addon_ledger_org_time_idx
  ON paid_addon_ledger_events(organization_id, occurred_at DESC);
CREATE TABLE IF NOT EXISTS paid_addon_ledger_audit (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  provider TEXT NOT NULL,
  external_reference TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'paid_addon_ingested'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, provider, external_reference)
    REFERENCES paid_addon_ledger_events(organization_id, provider, external_reference)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS paid_addon_ledger_audit_org_idx
  ON paid_addon_ledger_audit(organization_id, external_reference, created_at DESC);
CREATE OR REPLACE FUNCTION prevent_paid_addon_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM organizations WHERE id = OLD.organization_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Paid add-on ledger records are immutable';
END;
$$;
DROP TRIGGER IF EXISTS paid_addon_ledger_event_immutable ON paid_addon_ledger_events;
CREATE TRIGGER paid_addon_ledger_event_immutable
  BEFORE UPDATE OR DELETE ON paid_addon_ledger_events
  FOR EACH ROW EXECUTE FUNCTION prevent_paid_addon_ledger_mutation();
DROP TRIGGER IF EXISTS paid_addon_ledger_audit_immutable ON paid_addon_ledger_audit;
CREATE TRIGGER paid_addon_ledger_audit_immutable
  BEFORE UPDATE OR DELETE ON paid_addon_ledger_audit
  FOR EACH ROW EXECUTE FUNCTION prevent_paid_addon_ledger_mutation();
`;

function createPostgresPaidAddonLedgerStore({ db } = {}) {
  if (!db || typeof db.connect !== "function" || typeof db.query !== "function") {
    throw new Error("A PostgreSQL pool is required.");
  }

  async function transaction(work) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    durable: true,

    async ensureSchema() {
      await db.query(SCHEMA_SQL);
    },

    async ingest({ organizationId, events } = {}) {
      const tenant = organizationUuid(organizationId);
      if (!Array.isArray(events) || events.length > 500) {
        throw new Error("A batch of no more than 500 paid add-on events is required.");
      }
      const normalized = events.map(event => normalizePaidAddonLedgerEvent(event, tenant));
      const references = new Set();
      const externalIds = new Set();
      for (const event of normalized) {
        if (references.has(event.externalReference) || externalIds.has(event.externalIdentifier)) {
          throw new Error("A paid add-on batch cannot contain duplicate item or Veyra identifiers.");
        }
        references.add(event.externalReference);
        externalIds.add(event.externalIdentifier);
      }

      return transaction(async client => {
        let inserted = 0;
        let duplicates = 0;
        for (const event of normalized) {
          const digest = evidenceHash(event);
          const result = await client.query(
            "INSERT INTO paid_addon_ledger_events(organization_id,provider,external_reference,external_identifier,source_reference,reservation_id,gross_amount_minor,adjustment_amount_minor,amount_minor,currency,occurred_at,attribution_status,evidence,evidence_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) ON CONFLICT DO NOTHING RETURNING external_reference",
            [
              tenant,
              event.provider,
              event.externalReference,
              event.externalIdentifier,
              event.sourceReference,
              event.reservationId,
              event.grossAmountMinor,
              event.adjustmentAmountMinor,
              event.amountMinor,
              event.currency,
              event.occurredAt,
              event.attributionStatus,
              JSON.stringify(event.evidence),
              digest
            ]
          );
          if (result.rowCount === 1) {
            await client.query(
              "INSERT INTO paid_addon_ledger_audit(organization_id,provider,external_reference,event_type,evidence_sha256) VALUES($1,$2,$3,'paid_addon_ingested',$4)",
              [tenant, event.provider, event.externalReference, digest]
            );
            inserted += 1;
            continue;
          }

          const existing = await client.query(
            "SELECT external_reference,external_identifier,evidence_sha256 FROM paid_addon_ledger_events WHERE organization_id=$1 AND provider=$2 AND (external_reference=$3 OR external_identifier=$4) FOR UPDATE",
            [tenant, event.provider, event.externalReference, event.externalIdentifier]
          );
          if (existing.rowCount !== 1 ||
              existing.rows[0].external_reference !== event.externalReference ||
              existing.rows[0].external_identifier !== event.externalIdentifier ||
              existing.rows[0].evidence_sha256 !== digest) {
            throw new Error("Paid add-on evidence identifier collision; the batch was not ingested.");
          }
          duplicates += 1;
        }
        return Object.freeze({ inserted, duplicates });
      });
    },

    async get({ organizationId, externalReference } = {}) {
      const tenant = organizationUuid(organizationId);
      const reference = requiredId(externalReference, "externalReference");
      const result = await db.query(
        "SELECT organization_id,provider,external_reference,external_identifier,source_reference,reservation_id,gross_amount_minor,adjustment_amount_minor,amount_minor,currency,occurred_at,attribution_status,evidence,evidence_sha256,created_at FROM paid_addon_ledger_events WHERE organization_id=$1 AND provider='mews' AND external_reference=$2",
        [tenant, reference]
      );
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      return Object.freeze({
        organizationId: row.organization_id,
        provider: row.provider,
        externalReference: row.external_reference,
        externalIdentifier: row.external_identifier,
        sourceReference: row.source_reference,
        reservationId: row.reservation_id,
        grossAmountMinor: Number(row.gross_amount_minor),
        adjustmentAmountMinor: Number(row.adjustment_amount_minor),
        amountMinor: Number(row.amount_minor),
        currency: row.currency,
        occurredAt: new Date(row.occurred_at).toISOString(),
        attributionStatus: row.attribution_status,
        evidence: row.evidence,
        evidenceSha256: row.evidence_sha256,
        createdAt: row.created_at
      });
    },

    async listAuditEvents({ organizationId, externalReference } = {}) {
      const tenant = organizationUuid(organizationId);
      const reference = requiredId(externalReference, "externalReference");
      const result = await db.query(
        "SELECT event_type,evidence_sha256,created_at FROM paid_addon_ledger_audit WHERE organization_id=$1 AND provider='mews' AND external_reference=$2 ORDER BY id",
        [tenant, reference]
      );
      return result.rows.map(row => Object.freeze({
        eventType: row.event_type,
        evidenceSha256: row.evidence_sha256,
        createdAt: row.created_at
      }));
    }
  });
}

module.exports = {
  normalizePaidAddonLedgerEvent,
  createPostgresPaidAddonLedgerStore,
  evidenceHash
};
