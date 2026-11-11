-- Tenant-specific Slack incoming webhook configuration.
-- The webhook secret is AES-256-GCM encrypted by the application; the encryption
-- key must live only in the hosting provider's secret environment settings.
BEGIN;

CREATE TABLE tenant_integrations (
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('slack')),
  secret_ciphertext text NOT NULL,
  secret_iv text NOT NULL CHECK (length(secret_iv) = 16),
  secret_auth_tag text NOT NULL CHECK (length(secret_auth_tag) = 24),
  enabled boolean NOT NULL DEFAULT true,
  configured_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_integrations_isolation ON tenant_integrations
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;
