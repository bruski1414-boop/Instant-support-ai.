-- Per-hotel website origin allowlist for the public Veyra launcher.
BEGIN;
CREATE TABLE tenant_widget_settings (
  tenant_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  allowed_origins text[] NOT NULL DEFAULT ARRAY[]::text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(allowed_origins) <= 20)
);
ALTER TABLE tenant_widget_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_widget_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_widget_settings_isolation ON tenant_widget_settings
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
COMMIT;
