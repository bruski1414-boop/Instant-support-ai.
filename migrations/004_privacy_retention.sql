-- Workspace-controlled conversation retention policy.
-- Expired conversations and their messages are deleted by the application on workspace access.
BEGIN;
ALTER TABLE organizations
  ADD COLUMN conversation_retention_days integer NOT NULL DEFAULT 90
  CHECK (conversation_retention_days BETWEEN 30 AND 730);
COMMIT;
