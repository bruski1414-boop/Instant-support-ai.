const crypto = require("node:crypto");

const SESSION_COOKIE = "veyra_session";
const CSRF_COOKIE = "veyra_csrf";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SCRYPT = { N: 32768, r: 8, p: 1, keyLength: 64, maxmem: 64 * 1024 * 1024 };

function hashToken(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function safeEqual(a, b) {
  const left = Buffer.from(a || "");
  const right = Buffer.from(b || "");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!Object.hasOwn(cookies, key)) {
      try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = ""; }
    }
  }
  return cookies;
}

function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new Error("Password must be between 12 and 128 characters.");
  }
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keyLength, SCRYPT, (error, derived) => {
      if (error) return reject(error);
      resolve(`scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`);
    });
  });
}

async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 128 || typeof encoded !== "string") return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (N !== SCRYPT.N || r !== SCRYPT.r || p !== SCRYPT.p) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch { return false; }
  if (salt.length !== 16 || expected.length !== SCRYPT.keyLength) return false;
  return new Promise((resolve) => {
    crypto.scrypt(password, salt, SCRYPT.keyLength, SCRYPT, (error, actual) => {
      resolve(!error && crypto.timingSafeEqual(actual, expected));
    });
  });
}

async function inTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function appendCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  const existing = res.getHeader("Set-Cookie");
  const next = Array.isArray(existing) ? existing : existing ? [existing] : [];
  next.push(parts.join("; "));
  res.setHeader("Set-Cookie", next);
}

function clearCookie(res, name, options = {}) {
  appendCookie(res, name, "", { ...options, maxAge: 0 });
}

function originAllowed(req, configuredOrigin, production) {
  const origin = req.get("origin");
  if (!origin) return !production;
  if (configuredOrigin) return origin === configuredOrigin;
  if (production) return false;
  return origin === `${req.protocol}://${req.get("host")}`;
}

function createAuthRouter(app, { pool, env = process.env, logger = console }) {
  const secure = env.NODE_ENV === "production";
  const cookieOptions = { secure };
  const unavailable = (_req, res) => res.status(503).json({ error: "Account sign-in is not configured." });
  if (!pool) {
    app.post("/api/auth/login", unavailable);
    app.get("/api/auth/me", unavailable);
    app.post("/api/auth/logout", unavailable);
    return (_req, res) => res.redirect(303, "/login.html");
  }

  async function getSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token || token.length > 128) return null;
    const tokenHash = hashToken(token);
    return inTransaction(pool, async (client) => {
      await client.query("SELECT set_config('app.session_token_hash', $1, true)", [tokenHash.toString("hex")]);
      const result = await client.query(
        "SELECT user_id, csrf_hash, expires_at FROM user_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1",
        [tokenHash]
      );
      if (!result.rows[0]) return null;
      return { ...result.rows[0], tokenHash, csrfCookie: cookies[CSRF_COOKIE] || "" };
    });
  }

  async function requireAuth(req, res, next) {
    try {
      const session = await getSession(req);
      if (!session) return req.path.startsWith("/api/") ? res.status(401).json({ error: "Sign in required." }) : res.redirect(303, "/login.html");
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        const headerToken = req.get("x-csrf-token") || "";
        const csrfMatches = session.csrfCookie && safeEqual(session.csrfCookie, headerToken) &&
          safeEqual(hashToken(session.csrfCookie), session.csrf_hash);
        if (!originAllowed(req, env.APP_ORIGIN, secure) || !csrfMatches) {
          return res.status(403).json({ error: "CSRF validation failed." });
        }
      }
      const profile = await inTransaction(pool, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [session.user_id]);
        const user = await client.query("SELECT id, email FROM users WHERE id = $1 AND disabled_at IS NULL LIMIT 1", [session.user_id]);
        const memberships = await client.query("SELECT tenant_id, role FROM memberships WHERE user_id = $1 ORDER BY created_at", [session.user_id]);
        if (!user.rows[0] || !memberships.rows.length) return null;
        return { user: user.rows[0], memberships: memberships.rows };
      });
      if (!profile) return req.path.startsWith("/api/") ? res.status(401).json({ error: "Sign in required." }) : res.redirect(303, "/login.html");
      req.auth = profile;
      return next();
    } catch (error) {
      logger.error("Veyra dashboard authentication failed:", error?.message || "Unknown error");
      return res.status(503).send("Dashboard sign-in is temporarily unavailable.");
    }
  }

  app.post("/api/auth/login", async (req, res) => {
    if (!originAllowed(req, env.APP_ORIGIN, secure)) return res.status(403).json({ error: "Request origin is not allowed." });
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = req.body?.password;
    if (!email || email.length > 254 || typeof password !== "string" || password.length > 128) {
      return res.status(400).json({ error: "Enter a valid email and password." });
    }
    try {
      const credential = await inTransaction(pool, async (client) => {
        await client.query("SELECT set_config('app.login_email', $1, true)", [email]);
        const result = await client.query(
          "SELECT user_id, email, password_hash, disabled_at FROM auth_credentials WHERE email = $1 LIMIT 1",
          [email]
        );
        return result.rows[0] || null;
      });
      const valid = credential && !credential.disabled_at && await verifyPassword(password, credential.password_hash);
      if (!valid) return res.status(401).json({ error: "Email or password is incorrect." });

      const sessionToken = crypto.randomBytes(32).toString("base64url");
      const csrfToken = crypto.randomBytes(32).toString("base64url");
      const tokenHash = hashToken(sessionToken);
      const csrfHash = hashToken(csrfToken);
      const sessionCreated = await inTransaction(pool, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [credential.user_id]);
        const activeUser = await client.query(
          "SELECT id FROM users WHERE id = $1 AND disabled_at IS NULL LIMIT 1",
          [credential.user_id]
        );
        if (!activeUser.rows[0]) return false;
        await client.query(
          "INSERT INTO user_sessions (user_id, token_hash, csrf_hash, expires_at) VALUES ($1, $2, $3, now() + interval '8 hours')",
          [credential.user_id, tokenHash, csrfHash]
        );
        return true;
      });
      if (!sessionCreated) return res.status(401).json({ error: "Email or password is incorrect." });
      appendCookie(res, SESSION_COOKIE, sessionToken, { ...cookieOptions, httpOnly: true, maxAge: 8 * 60 * 60 });
      appendCookie(res, CSRF_COOKIE, csrfToken, { ...cookieOptions, maxAge: 8 * 60 * 60 });
      return res.json({ authenticated: true });
    } catch (error) {
      logger.error("Veyra login failed:", error?.message || "Unknown error");
      return res.status(503).json({ error: "Sign-in is temporarily unavailable." });
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    try {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ authenticated: false });
      const profile = await inTransaction(pool, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [session.user_id]);
        const [userResult, membershipsResult] = await Promise.all([
          client.query("SELECT id, email FROM users WHERE id = $1 AND disabled_at IS NULL LIMIT 1", [session.user_id]),
          client.query("SELECT tenant_id, role FROM memberships WHERE user_id = $1 ORDER BY created_at", [session.user_id]),
        ]);
        if (!userResult.rows[0]) return null;
        return { user: userResult.rows[0], memberships: membershipsResult.rows };
      });
      if (!profile) return res.status(401).json({ authenticated: false });
      return res.json({ authenticated: true, ...profile });
    } catch (error) {
      logger.error("Veyra session check failed:", error?.message || "Unknown error");
      return res.status(503).json({ error: "Session check is temporarily unavailable." });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    if (!originAllowed(req, env.APP_ORIGIN, secure)) return res.status(403).json({ error: "Request origin is not allowed." });
    try {
      const session = await getSession(req);
      if (session) {
        const headerToken = req.get("x-csrf-token") || "";
        const csrfMatches = session.csrfCookie && safeEqual(session.csrfCookie, headerToken) &&
          safeEqual(hashToken(session.csrfCookie), session.csrf_hash);
        if (!csrfMatches) return res.status(403).json({ error: "CSRF validation failed." });
        await inTransaction(pool, async (client) => {
          await client.query("SELECT set_config('app.user_id', $1, true)", [session.user_id]);
          await client.query(
            "UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL",
            [session.tokenHash, session.user_id]
          );
        });
      }
      clearCookie(res, SESSION_COOKIE, { ...cookieOptions, httpOnly: true });
      clearCookie(res, CSRF_COOKIE, cookieOptions);
      return res.json({ authenticated: false });
    } catch (error) {
      logger.error("Veyra logout failed:", error?.message || "Unknown error");
      return res.status(503).json({ error: "Sign-out is temporarily unavailable." });
    }
  });
  return requireAuth;
}

module.exports = { hashPassword, verifyPassword, parseCookies, hashToken, createAuthRouter };
