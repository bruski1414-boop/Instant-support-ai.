"use strict";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const EXTERNAL_ID = /^veyra-addon:[A-Za-z0-9._:-]{1,120}$/;
const HASH = /^[a-f0-9]{64}$/;
const REASON = /^[a-z0-9_]{1,80}$/;

function required(value, field, pattern = SAFE_ID) {
  if (typeof value !== "string" || !pattern.test(value.trim())) {
    throw new Error(field + " is invalid.");
  }
  return value.trim();
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mews_addon_write_requests (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 100),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  enterprise_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  external_identifier TEXT NOT NULL CHECK (external_identifier ~ '^veyra-addon:[A-Za-z0-9._:-]{1,120}$'),
  status TEXT NOT NULL CHECK (status IN ('in_progress','completed','uncertain')),
  mews_order_id TEXT,
  result JSONB,
  reason_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, idempotency_key),
  UNIQUE (organization_id, external_identifier),
  CHECK (
    (status = 'in_progress' AND mews_order_id IS NULL AND result IS NULL AND reason_code IS NULL) OR
    (status = 'completed' AND mews_order_id IS NOT NULL AND result IS NOT NULL AND reason_code IS NULL) OR
    (status = 'uncertain' AND result IS NULL AND reason_code IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS mews_addon_write_requests_status_idx
  ON mews_addon_write_requests(organization_id, status, updated_at);
CREATE TABLE IF NOT EXISTS mews_addon_write_audit (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  external_identifier TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('write_claimed','provider_order_accepted','provider_outcome_uncertain')),
  reason_code TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mews_addon_write_audit_tenant_idx
  ON mews_addon_write_audit(organization_id, idempotency_key, occurred_at);
CREATE OR REPLACE FUNCTION prevent_mews_addon_write_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Mews add-on write audit is immutable';
END;
$$;
DROP TRIGGER IF EXISTS mews_addon_write_audit_immutable ON mews_addon_write_audit;
CREATE TRIGGER mews_addon_write_audit_immutable
  BEFORE UPDATE OR DELETE ON mews_addon_write_audit
  FOR EACH ROW EXECUTE FUNCTION prevent_mews_addon_write_audit_mutation();
`;

function createPostgresMewsAddonWriteStore({ db } = {}) {
  if (!db || typeof db.connect !== "function" || typeof db.query !== "function") {
    throw new Error("A PostgreSQL pool is required.");
  }

  async function transaction(work) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
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

    async claim({ organizationId, idempotencyKey, requestHash, enterpriseId, serviceId, reservationId, externalIdentifier } = {}) {
      const org = required(organizationId, "organizationId");
      const key = required(idempotencyKey, "idempotencyKey");
      if (key.length > 100) throw new Error("idempotencyKey is too long.");
      const hash = required(requestHash, "requestHash", HASH);
      const enterprise = required(enterpriseId, "enterpriseId");
      const service = required(serviceId, "serviceId");
      const reservation = required(reservationId, "reservationId");
      const external = required(externalIdentifier, "externalIdentifier", EXTERNAL_ID);

      return transaction(async client => {
        const inserted = await client.query(
          "INSERT INTO mews_addon_write_requests(organization_id,idempotency_key,request_sha256,enterprise_id,service_id,reservation_id,external_identifier,status) VALUES($1,$2,$3,$4,$5,$6,$7,'in_progress') ON CONFLICT (organization_id,idempotency_key) DO NOTHING RETURNING external_identifier,status",
          [org, key, hash, enterprise, service, reservation, external]
        );
        if (inserted.rowCount === 1) {
          await client.query(
            "INSERT INTO mews_addon_write_audit(organization_id,idempotency_key,external_identifier,event_type) VALUES($1,$2,$3,'write_claimed')",
            [org, key, external]
          );
          return { status: "acquired", externalIdentifier: external };
        }

        const existing = await client.query(
          "SELECT request_sha256,external_identifier,status,result,mews_order_id FROM mews_addon_write_requests WHERE organization_id=$1 AND idempotency_key=$2 FOR UPDATE",
          [org, key]
        );
        if (existing.rowCount !== 1) throw new Error("The add-on write identifier is already in use.");
        const row = existing.rows[0];
        if (row.request_sha256 !== hash) return { status: "conflict" };
        if (row.status === "completed") {
          return { status: "completed", externalIdentifier: row.external_identifier, result: row.result };
        }
        return { status: row.status, externalIdentifier: row.external_identifier, mewsOrderId: row.mews_order_id || null };
      });
    },

    async complete({ organizationId, idempotencyKey, requestHash, mewsOrderId, result } = {}) {
      const org = required(organizationId, "organizationId");
      const key = required(idempotencyKey, "idempotencyKey");
      const hash = required(requestHash, "requestHash", HASH);
      const orderId = required(mewsOrderId, "mewsOrderId");
      if (!result || typeof result !== "object" || Array.isArray(result) || result.mewsOrderId !== orderId) {
        throw new Error("A matching Mews order result is required.");
      }
      return transaction(async client => {
        const updated = await client.query(
          "UPDATE mews_addon_write_requests SET status='completed',mews_order_id=$4,result=$5::jsonb,reason_code=NULL,updated_at=now() WHERE organization_id=$1 AND idempotency_key=$2 AND request_sha256=$3 AND status='in_progress' RETURNING external_identifier",
          [org, key, hash, orderId, JSON.stringify(result)]
        );
        if (updated.rowCount !== 1) throw new Error("The add-on write cannot be completed from its current state.");
        await client.query(
          "INSERT INTO mews_addon_write_audit(organization_id,idempotency_key,external_identifier,event_type) VALUES($1,$2,$3,'provider_order_accepted')",
          [org, key, updated.rows[0].external_identifier]
        );
      });
    },

    async markUncertain({ organizationId, idempotencyKey, requestHash, reasonCode, mewsOrderId = null } = {}) {
      const org = required(organizationId, "organizationId");
      const key = required(idempotencyKey, "idempotencyKey");
      const hash = required(requestHash, "requestHash", HASH);
      const reason = required(reasonCode, "reasonCode", REASON);
      const orderId = mewsOrderId === null ? null : required(mewsOrderId, "mewsOrderId");
      return transaction(async client => {
        const updated = await client.query(
          "UPDATE mews_addon_write_requests SET status='uncertain',mews_order_id=$4,result=NULL,reason_code=$5,updated_at=now() WHERE organization_id=$1 AND idempotency_key=$2 AND request_sha256=$3 AND status='in_progress' RETURNING external_identifier",
          [org, key, hash, orderId, reason]
        );
        if (updated.rowCount !== 1) throw new Error("The add-on write cannot be marked uncertain from its current state.");
        await client.query(
          "INSERT INTO mews_addon_write_audit(organization_id,idempotency_key,external_identifier,event_type,reason_code) VALUES($1,$2,$3,'provider_outcome_uncertain',$4)",
          [org, key, updated.rows[0].external_identifier, reason]
        );
      });
    },

    async get({ organizationId, idempotencyKey } = {}) {
      const org = required(organizationId, "organizationId");
      const key = required(idempotencyKey, "idempotencyKey");
      const result = await db.query(
        "SELECT organization_id,enterprise_id,service_id,reservation_id,external_identifier,status,mews_order_id,result,reason_code,created_at,updated_at FROM mews_addon_write_requests WHERE organization_id=$1 AND idempotency_key=$2",
        [org, key]
      );
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      return {
        organizationId: row.organization_id,
        enterpriseId: row.enterprise_id,
        serviceId: row.service_id,
        reservationId: row.reservation_id,
        externalIdentifier: row.external_identifier,
        status: row.status,
        mewsOrderId: row.mews_order_id,
        result: row.result,
        reasonCode: row.reason_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

    async listAuditEvents({ organizationId, idempotencyKey } = {}) {
      const org = required(organizationId, "organizationId");
      const key = required(idempotencyKey, "idempotencyKey");
      const result = await db.query(
        "SELECT event_type,reason_code,occurred_at FROM mews_addon_write_audit WHERE organization_id=$1 AND idempotency_key=$2 ORDER BY id",
        [org, key]
      );
      return result.rows.map(row => ({
        eventType: row.event_type,
        reasonCode: row.reason_code,
        occurredAt: row.occurred_at
      }));
    }
  });
}

module.exports = { createPostgresMewsAddonWriteStore, SCHEMA_SQL };
