const { Pool } = require("pg");

const REQUIRED_TABLES = [
  "organizations",
  "users",
  "memberships",
  "user_sessions",
  "auth_credentials",
  "knowledge_documents",
  "conversations",
  "messages",
  "audit_events",
  "tenant_integrations",
  "tenant_widget_settings",
];

function validateEnvironment(env = process.env) {
  const issues = [];
  for (const key of ["DATABASE_URL", "OPENAI_API_KEY", "TENANT_INTEGRATION_ENCRYPTION_KEY", "APP_ORIGIN"]) {
    if (typeof env[key] !== "string" || !env[key].trim()) issues.push("Missing required environment variable: " + key);
  }

  if (env.NODE_ENV !== "production") issues.push("NODE_ENV must be set to production.");
  if (env.DATABASE_SSL !== "true") {
    issues.push("DATABASE_SSL must be true in production so PostgreSQL connections use verified TLS.");
  }

  if (env.APP_ORIGIN) {
    try {
      const origin = new URL(env.APP_ORIGIN);
      if (origin.protocol !== "https:" || origin.origin !== env.APP_ORIGIN || origin.username || origin.password) {
        issues.push("APP_ORIGIN must be an exact HTTPS origin with no path, query, fragment, or trailing slash.");
      }
    } catch {
      issues.push("APP_ORIGIN must be a valid HTTPS origin.");
    }
  }

  if (env.TENANT_INTEGRATION_ENCRYPTION_KEY) {
    try {
      const decoded = Buffer.from(env.TENANT_INTEGRATION_ENCRYPTION_KEY, "base64");
      if (decoded.length !== 32 || decoded.toString("base64") !== env.TENANT_INTEGRATION_ENCRYPTION_KEY) {
        issues.push("TENANT_INTEGRATION_ENCRYPTION_KEY must be a canonical base64 encoding of exactly 32 random bytes.");
      }
    } catch {
      issues.push("TENANT_INTEGRATION_ENCRYPTION_KEY must be a canonical base64 encoding of exactly 32 random bytes.");
    }
  }

  return issues;
}

async function runPreflight({ env = process.env, poolFactory = (config) => new Pool(config) } = {}) {
  const issues = validateEnvironment(env);
  if (issues.length) return { ok: false, issues };

  const pool = poolFactory({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    ...(env.DATABASE_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  try {
    const roleResult = await pool.query(
      "SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = current_user"
    );
    const role = roleResult.rows[0];
    if (!role) {
      issues.push("Could not identify the connected database role.");
    } else {
      if (role.rolsuper || role.rolbypassrls) issues.push("The application database role must not be a superuser or have BYPASSRLS.");
      if (role.rolcreatedb || role.rolcreaterole) issues.push("The application database role must not be allowed to create databases or roles.");
      if (!role.rolcanlogin) issues.push("The application database role must be able to log in.");
    }

    const tableResult = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = ANY($1::text[])",
      [REQUIRED_TABLES]
    );
    const foundTables = new Set(tableResult.rows.map((row) => row.table_name));
    for (const table of REQUIRED_TABLES) {
      if (!foundTables.has(table)) issues.push("Required database table is missing: public." + table);
    }

    const rlsResult = await pool.query(
      "SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity, EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS has_policy FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])",
      [REQUIRED_TABLES]
    );
    const rlsByTable = new Map(rlsResult.rows.map((row) => [row.table_name, row]));
    for (const table of REQUIRED_TABLES) {
      const state = rlsByTable.get(table);
      if (!state) continue;
      if (!state.relrowsecurity || !state.relforcerowsecurity || !state.has_policy) {
        issues.push("Row-level security must be enabled, forced, and policy-backed on public." + table);
      }
    }

    const ownershipResult = await pool.query(
      "SELECT count(*)::int AS owned_count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND r.rolname = current_user",
      [REQUIRED_TABLES]
    );
    if (Number(ownershipResult.rows[0]?.owned_count || 0) > 0) {
      issues.push("The application database role must not own application tables; use a separate migration/owner account.");
    }

    return { ok: issues.length === 0, issues };
  } catch (error) {
    const code = typeof error?.code === "string" ? " (database error " + error.code + ")" : "";
    return { ok: false, issues: ["Database preflight could not complete" + code + ". Check connectivity and schema setup without sharing connection strings."] };
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runPreflight().then((result) => {
    if (result.ok) {
      process.stdout.write("Veyra deployment preflight passed. Runtime role, required schema, and RLS checks are ready.\n");
    } else {
      process.stderr.write("Veyra deployment preflight blocked:\n" + result.issues.map((issue) => "- " + issue).join("\n") + "\n");
      process.exitCode = 1;
    }
  }).catch(() => {
    process.stderr.write("Veyra deployment preflight failed unexpectedly. No credentials were printed.\n");
    process.exitCode = 1;
  });
}

module.exports = { REQUIRED_TABLES, validateEnvironment, runPreflight };
