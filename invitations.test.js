const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const server = fs.readFileSync("server.js", "utf8");
const dashboard = fs.readFileSync("dashboard.html", "utf8");
const invitePage = fs.readFileSync("invite.html", "utf8");

test("invitation tokens are high entropy and only hashes are stored", () => {
  assert.match(server, /crypto\.randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(server, /token_hash,expires_at/);
  assert.match(server, /hash\(token\)/);
  assert.match(server, /INSERT INTO user_invitations\(organization_id,email,role,token_hash,expires_at,created_by\)/);
});

test("invitation creation is workspace-scoped and role-limited", () => {
  assert.match(server, /role\("owner","admin"\).*api\/admin\/invitations/s);
  assert.match(server, /q\.actor\.role!=="owner"&&inviteRole==="admin"/);
  assert.match(server, /WHERE organization_id=\$1 AND email=\$2/);
  assert.match(server, /now\(\)\+interval '24 hours'/);
});

test("invitation acceptance is single-use, expires, and checks workspace and email", () => {
  assert.match(server, /i\.token_hash=\$1 AND o\.slug=\$2 AND i\.email=\$3/);
  assert.match(server, /i\.accepted_at IS NULL AND i\.revoked_at IS NULL/);
  assert.match(server, /i\.expires_at>now\(\)/);
  assert.match(server, /UPDATE user_invitations SET accepted_at=now\(\)/);
  assert.match(server, /invitationAcceptLimiter/);
});

test("dashboard exposes team invitations only to owner/admin", () => {
  assert.match(dashboard, /data-panel="team"/);
  assert.match(dashboard, /\["owner","admin"\]\.includes\(currentRole\)/);
  assert.match(dashboard, /api\/admin\/invitations/);
  assert.match(dashboard, /revoke-invitation/);
});

test("acceptance page validates link and uses server-side acceptance endpoint", () => {
  assert.match(invitePage, /api\/invitations\/accept/);
  assert.match(invitePage, /minlength="12"/);
  assert.match(invitePage, /A-Za-z0-9_-\]\{40,64\}/);
});

test("hotel onboarding readiness checks real configuration and privacy gate", () => {
  assert.match(server, /CREATE TABLE IF NOT EXISTS organization_settings/);
  assert.match(server, /app\.get\("\/api\/admin\/onboarding"/);
  assert.match(server, /app\.put\("\/api\/admin\/settings"/);
  assert.match(server, /origins\.includes\(new URL\(p\.website_url\)\.origin\)/);
  assert.match(server, /GUEST_DATA_STORAGE_ENABLED==="true"/);
  assert.match(server, /checks\.every\(x=>x\.done\)/);
  assert.match(dashboard, /data-panel="setup"/);
  assert.match(dashboard, /api\("\/api\/admin\/onboarding"\)/);
  assert.match(dashboard, /settingsForm/);
});
