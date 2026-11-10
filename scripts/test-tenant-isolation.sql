-- Run after migrations/001_multi_tenant_foundation.sql as the database owner.
-- Verifies actual PostgreSQL RLS with a non-owner, non-superuser runtime role.
\set ON_ERROR_STOP on

CREATE ROLE veyra_runtime_test LOGIN PASSWORD 'ci-only-test-password';
GRANT CONNECT ON DATABASE postgres TO veyra_runtime_test;
GRANT USAGE ON SCHEMA public TO veyra_runtime_test;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO veyra_runtime_test;

INSERT INTO organizations (id, name) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Hotel A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Hotel B');

INSERT INTO users (id, email, password_hash) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'owner@example.test', repeat('x', 60));

INSERT INTO auth_credentials (user_id, email, password_hash) VALUES
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'owner@example.test', repeat('x', 60));

INSERT INTO memberships (tenant_id, user_id, role) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'owner');

INSERT INTO conversations (tenant_id, id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222');

SET ROLE veyra_runtime_test;

DO $$
DECLARE visible_count integer;
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'runtime role must not be superuser or BYPASSRLS';
  END IF;
  SELECT count(*) INTO visible_count FROM conversations;
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'tenant context missing but % conversations visible', visible_count;
  END IF;
END $$;

BEGIN;
SELECT set_config('app.login_email', 'owner@example.test', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM auth_credentials) <> 1 THEN
    RAISE EXCEPTION 'email-scoped credential lookup should return exactly one row';
  END IF;
END $$;
SELECT set_config('app.login_email', '', true);
SELECT set_config('app.user_id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
SELECT set_config('app.tenant_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM conversations;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'tenant A should see exactly one conversation, saw %', visible_count;
  END IF;
  IF (SELECT count(*) FROM organizations) <> 1 THEN
    RAISE EXCEPTION 'tenant A should see only its organization';
  END IF;
  IF (SELECT count(*) FROM memberships) <> 1 THEN
    RAISE EXCEPTION 'user should see their own membership';
  END IF;
  IF (SELECT count(*) FROM users) <> 1 THEN
    RAISE EXCEPTION 'user should see their own account';
  END IF;

  INSERT INTO user_sessions (user_id, token_hash, csrf_hash, expires_at)
  VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', decode(repeat('ab', 32), 'hex'), decode(repeat('cd', 32), 'hex'), now() + interval '8 hours');
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.session_token_hash', repeat('ab', 32), true);
  IF (SELECT count(*) FROM user_sessions) <> 1 THEN
    RAISE EXCEPTION 'session lookup by presented token hash should return one row';
  END IF;
  PERFORM set_config('app.session_token_hash', repeat('ef', 32), true);
  IF (SELECT count(*) FROM user_sessions) <> 0 THEN
    RAISE EXCEPTION 'session lookup must not reveal another token hash';
  END IF;
  PERFORM set_config('app.user_id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
  PERFORM set_config('app.session_token_hash', repeat('ab', 32), true);
  UPDATE user_sessions SET revoked_at = now() WHERE token_hash = decode(repeat('ab', 32), 'hex');
  IF (SELECT count(*) FROM user_sessions) <> 0 THEN
    RAISE EXCEPTION 'revoked session must no longer be visible';
  END IF;

  INSERT INTO messages (tenant_id, conversation_id, sender_type, body)
  VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          '11111111-1111-4111-8111-111111111111', 'guest', 'synthetic test');

  BEGIN
    INSERT INTO messages (tenant_id, conversation_id, sender_type, body)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            '22222222-2222-4222-8222-222222222222', 'guest', 'must be blocked');
    RAISE EXCEPTION 'cross-tenant insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- Expected: RLS WITH CHECK rejected tenant B.
  END;
END $$;
ROLLBACK;

RESET ROLE;
DROP OWNED BY veyra_runtime_test;
DROP ROLE veyra_runtime_test;
