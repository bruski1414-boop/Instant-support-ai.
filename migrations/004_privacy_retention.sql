-- Workspace-controlled conversation retention policy.
-- Expired conversations and their messages are deleted by the application on workspace access.
BEGIN;
ALTER TABLE organizations
  ADD COLUMN conversation_retention_days integer NOT NULL DEFAULT 90
  CHECK (conversation_retention_days BETWEEN 30 AND 730);
CREATE POLICY organizations_owner_admin_update ON organizations
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.tenant_id = organizations.id
        AND m.user_id = app_current_user_id()
        AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.tenant_id = organizations.id
        AND m.user_id = app_current_user_id()
        AND m.role IN ('owner', 'admin')
    )
  );
COMMIT;
