"use strict";

function required(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      [...value].some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })) throw new Error(field + " is invalid.");
  return value.trim();
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mews_reservation_idempotency (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_sha256 CHAR(64) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress','completed','uncertain')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, idempotency_key),
  CHECK (
    (status = 'completed' AND result IS NOT NULL) OR
    (status <> 'completed' AND result IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS mews_reservation_idempotency_updated_idx
  ON mews_reservation_idempotency(updated_at);
`;

function createPostgresMewsIdempotencyStore({ db } = {}) {
  if (!db || typeof db.query !== "function") throw new Error("A PostgreSQL query client is required.");

  return Object.freeze({
    durable: true,

    async ensureSchema() {
      await db.query(SCHEMA_SQL);
    },

    async claim({ organizationId, idempotencyKey, requestHash } = {}) {
      const org = required(organizationId, "organizationId", 128);
      const key = required(idempotencyKey, "idempotencyKey", 100);
      const hash = required(requestHash, "requestHash", 64);
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("requestHash must be a SHA-256 hex digest.");

      const inserted = await db.query(
        "INSERT INTO mews_reservation_idempotency(organization_id,idempotency_key,request_sha256,status) VALUES($1,$2,$3,'in_progress') ON CONFLICT(organization_id,idempotency_key) DO NOTHING RETURNING status",
        [org, key, hash]
      );
      if (inserted.rowCount === 1) return { status: "acquired" };

      const existing = await db.query(
        "SELECT request_sha256,status,result FROM mews_reservation_idempotency WHERE organization_id=$1 AND idempotency_key=$2",
        [org, key]
      );
      if (existing.rowCount !== 1) throw new Error("Idempotency claim could not be reconciled.");
      const row = existing.rows[0];
      if (row.request_sha256 !== hash) return { status: "conflict" };
      if (row.status === "completed" && row.result) return { status: "completed", result: row.result };
      return { status: row.status };
    },

    async release({ organizationId, idempotencyKey, requestHash } = {}) {
      const org = required(organizationId, "organizationId", 128);
      const key = required(idempotencyKey, "idempotencyKey", 100);
      const hash = required(requestHash, "requestHash", 64);
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("requestHash must be a SHA-256 hex digest.");
      const deleted = await db.query(
        "DELETE FROM mews_reservation_idempotency WHERE organization_id=$1 AND idempotency_key=$2 AND request_sha256=$3 AND status='in_progress'",
        [org, key, hash]
      );
      if (deleted.rowCount !== 1) throw new Error("Preflight reservation claim could not be safely released.");
    },

    async complete({ organizationId, idempotencyKey, requestHash, result } = {}) {
      const org = required(organizationId, "organizationId", 128);
      const key = required(idempotencyKey, "idempotencyKey", 100);
      const hash = required(requestHash, "requestHash", 64);
      if (!/^[a-f0-9]{64}$/.test(hash) || !result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("A valid request hash and result are required.");
      }
      const updated = await db.query(
        "UPDATE mews_reservation_idempotency SET status='completed',result=$4::jsonb,updated_at=now() WHERE organization_id=$1 AND idempotency_key=$2 AND request_sha256=$3 AND status='in_progress'",
        [org, key, hash, JSON.stringify(result)]
      );
      if (updated.rowCount !== 1) throw new Error("Idempotency result could not be committed.");
    },

    async markUncertain({ organizationId, idempotencyKey, requestHash, reason } = {}) {
      const org = required(organizationId, "organizationId", 128);
      const key = required(idempotencyKey, "idempotencyKey", 100);
      const hash = required(requestHash, "requestHash", 64);
      const safeReason = required(reason, "reason", 120);
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("requestHash must be a SHA-256 hex digest.");
      const updated = await db.query(
        "UPDATE mews_reservation_idempotency SET status='uncertain',result=NULL,updated_at=now() WHERE organization_id=$1 AND idempotency_key=$2 AND request_sha256=$3 AND status='in_progress'",
        [org, key, hash]
      );
      if (updated.rowCount !== 1) throw new Error("Uncertain reservation state could not be recorded: " + safeReason);
    }
  });
}

module.exports = { createPostgresMewsIdempotencyStore, SCHEMA_SQL };
