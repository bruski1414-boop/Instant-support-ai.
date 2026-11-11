-- Authentication support for Veyra AI.
-- Apply after 001_multi_tenant_foundation.sql on a reviewed private database.
BEGIN;

-- Login can retrieve only the credential row for the email explicitly scoped
-- to the current transaction. This table contains no guest or tenant content.
CREATE TABLE auth_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE CHECK (email = lower(trim(email))),
  password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 50 AND 255),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auth_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_credentials_email_lookup ON auth_credentials
  FOR SELECT USING (
    email = nullif(current_setting('app.login_email', true), '')
  );

-- A session can be looked up only by the SHA-256 token hash derived from the
-- opaque cookie presented by the client. The raw token is never stored.
CREATE POLICY sessions_token_lookup ON user_sessions
  FOR SELECT USING (
    token_hash = decode(nullif(current_setting('app.session_token_hash', true), ''), 'hex')
    AND revoked_at IS NULL
    AND expires_at > now()
  );

CREATE POLICY sessions_self_insert ON user_sessions
  FOR INSERT WITH CHECK (user_id = app_current_user_id());

CREATE POLICY sessions_self_revoke ON user_sessions
  FOR UPDATE USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

COMMIT;
