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
  assert.match(server, /u\.protocol==="https:"&&u\.origin===p\.website_url/);
  assert.match(server, /website=u\.origin/);
  assert.match(server, /GUEST_DATA_STORAGE_ENABLED==="true"/);
  assert.match(server, /checks\.every\(x=>x\.done\)/);
  assert.match(dashboard, /data-panel="setup"/);
  assert.match(dashboard, /api\("\/api\/admin\/onboarding"\)/);
  assert.match(dashboard, /settingsForm/);
});

test("hotel knowledge records its source and review date, and expired documents are excluded from AI context", () => {
  assert.match(server, /source_reference TEXT NOT NULL DEFAULT ''/);
  assert.match(server, /review_due_at DATE/);
  assert.match(server, /reviewed_at TIMESTAMPTZ/);
  assert.match(server, /ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS review_due_at DATE/);
  assert.match(server, /review_due_at>=CURRENT_DATE/);
  assert.match(server, /knowledge_document_versions\(organization_id,document_id,title,category,content,approved,source_reference,review_due_at,reviewed_at/);
  assert.match(dashboard, /id="kSource"/);
  assert.match(dashboard, /id="kReviewDue"/);
  assert.match(dashboard, /source_reference/);
});

test("workspace owners and admins can revoke individual staff access safely", () => {
  assert.match(server, /app\.get\("\/api\/admin\/users"/);
  assert.match(server, /app\.patch\("\/api\/admin\/users\/:id"/);
  assert.match(server, /You cannot deactivate your own account/);
  assert.match(server, /workspace owner account cannot be changed/);
  assert.match(server, /DELETE FROM sessions WHERE user_id=\$1/);
  assert.match(server, /user\.deactivated/);
  assert.match(dashboard, /id="memberList"/);
  assert.match(dashboard, /data-action="toggle-user"/);
});

test("workspace audit viewer is tenant-scoped and owner/admin-only", () => {
  assert.match(server, /app\.get\("\/api\/admin\/audit",requireDb,auth,role\("owner","admin"\)/);
  assert.match(server, /WHERE a\.organization_id=\$1 ORDER BY a\.created_at DESC LIMIT 100/);
  assert.match(dashboard, /id="auditList"/);
  assert.match(dashboard, /api\("\/api\/admin\/audit"\)/);
});

test("Render process health stays HTTP 200 while pilot readiness is reported separately", () => {
  assert.match(server, /app\.get\("\/api\/health".*r\.status\(200\)/s);
  assert.match(server, /app\.get\("\/api\/readiness".*r\.status\(state\.readyForPilot\?200:503\)/s);
  assert.match(server, /readyForPilot/);
});

test("pilot readiness counts only approved knowledge that is still in review date", () => {
  assert.match(server, /approved_count FROM knowledge_documents WHERE organization_id=\$1 AND approved=true AND \(review_due_at IS NULL OR review_due_at>=CURRENT_DATE\)/);
});
