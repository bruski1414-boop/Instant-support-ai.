require("dotenv").config();
const readline = require("node:readline/promises");
const { Pool } = require("pg");
const { hashPassword } = require("../auth");

async function readHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Run this command in a real terminal so the password can be entered without echo.");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") return finish(new Error("Cancelled."));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " " && char <= "~" && value.length < 128) value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const connectionString = process.env.PROVISION_DATABASE_URL;
  if (!connectionString) throw new Error("Set PROVISION_DATABASE_URL to a private, privileged database connection. Do not use the app runtime connection.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = (await rl.question("First owner's email: ")).trim().toLowerCase();
  const organizationName = (await rl.question("Hotel / organization name: ")).trim();
  rl.close();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("Enter a valid email address.");
  if (!organizationName || organizationName.length > 160) throw new Error("Organization name must be 1–160 characters.");

  const password = await readHidden("Create a password (12–128 characters): ");
  const confirmation = await readHidden("Confirm password: ");
  if (password.length < 12 || password.length > 128 || password !== confirmation) throw new Error("Passwords must match and be 12–128 characters.");
  const passwordHash = await hashPassword(password);
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT (SELECT count(*) FROM organizations) AS organizations, (SELECT count(*) FROM users) AS users");
    if (Number(existing.rows[0].organizations) !== 0 || Number(existing.rows[0].users) !== 0) {
      throw new Error("First-owner bootstrap is allowed only on a completely empty database. No changes were made.");
    }
    const organization = await client.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [organizationName]);
    const user = await client.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, passwordHash]
    );
    await client.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
      [organization.rows[0].id, user.rows[0].id]
    );
    await client.query(
      "INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, $2, $3)",
      [user.rows[0].id, email, passwordHash]
    );
    await client.query("COMMIT");
    process.stdout.write("First owner account created. Sign in through the Veyra login endpoint.\n");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Owner provisioning failed: ${error.message}\n`);
  process.exitCode = 1;
});
