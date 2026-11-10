const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { createApp } = require("../server");
const { hashPassword } = require("../auth");

const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROLE = "veyra_auth_test";
const PASSWORD = "ci-only-test-password";

async function main() {
  const admin = new Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "postgres",
  });
  let runtimePool;
  let server;
  const slackDeliveries = [];
  const encryptionKey = Buffer.alloc(32, 7).toString("base64");
  try {
    await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT CONNECT ON DATABASE postgres TO ${ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);

    const passwordHash = await hashPassword("a-ci-only-long-password");
    await admin.query("INSERT INTO organizations (id, name) VALUES ($1, 'Auth Test Hotel'), ($2, 'Other Test Hotel')", [TENANT_ID, OTHER_TENANT_ID]);
    await admin.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, 'auth-test@example.test', $2)",
      [USER_ID, passwordHash]
    );
    await admin.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
      [TENANT_ID, USER_ID]
    );
    await admin.query(
      "INSERT INTO auth_credentials (user_id, email, password_hash) VALUES ($1, 'auth-test@example.test', $2)",
      [USER_ID, passwordHash]
    );

    runtimePool = new Pool({
      host: process.env.PGHOST || "127.0.0.1",
      port: Number(process.env.PGPORT || 5432),
      user: ROLE,
      password: PASSWORD,
      database: process.env.PGDATABASE || "postgres",
      max: 3,
    });
    const app = createApp({ dbPool: runtimePool, env: { NODE_ENV: "test", TENANT_INTEGRATION_ENCRYPTION_KEY: encryptionKey }, fetchImpl: async (url, init) => { slackDeliveries.push({ url, payload: JSON.parse(init.body) }); return { ok: true, status: 200 }; }, openaiClient: { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ reply: "Breakfast is served from 7 AM to 10 AM.", needsHuman: false, handoffReason: "" }) } }] }) } } }, logger: { error() {} } });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const origin = base;

    const invalid = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "auth-test@example.test", password: "incorrect-password" }),
    });
    assert.equal(invalid.status, 401, "invalid password must be rejected");

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "AUTH-TEST@example.test", password: "a-ci-only-long-password" }),
    });
    assert.equal(login.status, 200, "valid credentials should create a session");
    const cookieHeader = login.headers.get("set-cookie") || "";
    const sessionMatch = cookieHeader.match(/veyra_session=([^;,]+)/);
    const csrfMatch = cookieHeader.match(/veyra_csrf=([^;,]+)/);
    assert.ok(sessionMatch && csrfMatch, "login must set session and CSRF cookies");
    const cookies = `veyra_session=${sessionMatch[1]}; veyra_csrf=${csrfMatch[1]}`;

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookies } });
    assert.equal(me.status, 200, "session should authenticate");
    const profile = await me.json();
    assert.equal(profile.authenticated, true);
    assert.equal(profile.user.email, "auth-test@example.test");
    assert.equal(profile.memberships.length, 1);
    assert.equal(profile.memberships[0].role, "owner");

    const dashboard = await fetch(`${base}/dashboard.html`, { headers: { cookie: cookies }, redirect: "manual" });
    assert.equal(dashboard.status, 200, "valid session and membership should open the dashboard");
    assert.match(await dashboard.text(), /Veyra AI command centre/);


    const workspacesResponse = await fetch(base + "/api/workspaces", { headers: { cookie: cookies } });
    assert.equal(workspacesResponse.status, 200);
    const workspaces = await workspacesResponse.json();
    assert.equal(workspaces.workspaces.length, 1, "only the user's own workspace should be listed");
    assert.equal(workspaces.workspaces[0].id, TENANT_ID);

    const csrfToken = decodeURIComponent(csrfMatch[1]);
    const workspaceHeaders = { cookie: cookies, "content-type": "application/json", "x-veyra-workspace": TENANT_ID, "x-csrf-token": csrfToken, origin };
    const draftResponse = await fetch(base + "/api/knowledge", { method: "POST", headers: workspaceHeaders, body: JSON.stringify({ title: "Breakfast", content: "Breakfast is served from 7 AM to 10 AM." }) });
    assert.equal(draftResponse.status, 201, "owner should be able to create a draft knowledge document");
    const draft = (await draftResponse.json()).document;
    assert.equal(draft.approved_at, null, "new knowledge must start as a draft");
    const approveResponse = await fetch(base + "/api/knowledge/" + draft.id + "/approve", { method: "POST", headers: workspaceHeaders, body: "{}" });
    assert.equal(approveResponse.status, 200, "owner should be able to approve knowledge");
    const editResponse = await fetch(base + "/api/knowledge/" + draft.id, { method: "PUT", headers: workspaceHeaders, body: JSON.stringify({ title: "Breakfast", content: "Breakfast is served from 7 AM to 10 AM.", version: 1 }) });
    assert.equal(editResponse.status, 200, "owner should be able to edit knowledge");
    const edited = (await editResponse.json()).document;
    assert.equal(edited.version, 2, "knowledge edit should increment version");
    assert.equal(edited.approved_at, null, "editing approved facts must revoke approval");
    const reapproveResponse = await fetch(base + "/api/knowledge/" + draft.id + "/approve", { method: "POST", headers: workspaceHeaders, body: "{}" });
    assert.equal(reapproveResponse.status, 200, "edited knowledge should be approvable again");

    const otherTenantResponse = await fetch(base + "/api/knowledge", { headers: { cookie: cookies, "x-veyra-workspace": OTHER_TENANT_ID } });
    assert.equal(otherTenantResponse.status, 403, "membership check must block another hotel's data");

    const conversationResponse = await fetch(base + "/api/conversations", { method: "POST", headers: workspaceHeaders, body: JSON.stringify({ channel: "website" }) });
    assert.equal(conversationResponse.status, 201, "staff should be able to create a conversation");
    const conversation = (await conversationResponse.json()).conversation;
    const staffMessage = await fetch(base + "/api/conversations/" + conversation.id + "/messages", { method: "POST", headers: workspaceHeaders, body: JSON.stringify({ body: "Our team will review this request." }) });
    assert.equal(staffMessage.status, 201, "staff message should be stored");
    const statusResponse = await fetch(base + "/api/conversations/" + conversation.id + "/status", { method: "PATCH", headers: workspaceHeaders, body: JSON.stringify({ status: "resolved" }) });
    assert.equal(statusResponse.status, 200, "staff should be able to resolve a conversation");
    const detail = await fetch(base + "/api/conversations/" + conversation.id, { headers: workspaceHeaders });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).messages.length, 1);

    const missingCsrf = await fetch(base + "/api/integrations/slack", { method: "POST", headers: { cookie: cookies, "content-type": "application/json", "x-veyra-workspace": TENANT_ID, origin }, body: JSON.stringify({ webhookUrl: "https://hooks.slack.com/services/test/tenant/secret" }) });
    assert.equal(missingCsrf.status, 403, "authenticated mutations must reject requests without CSRF validation");
    const invalidIntegration = await fetch(base + "/api/integrations/slack", { method: "POST", headers: workspaceHeaders, body: JSON.stringify({ webhookUrl: "https://example.com/steal" }) });
    assert.equal(invalidIntegration.status, 400, "only approved Slack webhook hosts should be accepted");
    const saveIntegration = await fetch(base + "/api/integrations/slack", { method: "POST", headers: workspaceHeaders, body: JSON.stringify({ webhookUrl: "https://hooks.slack.com/services/test/tenant/secret" }) });
    assert.equal(saveIntegration.status, 201, "workspace owner should be able to save an encrypted Slack integration");
    assert.equal((await saveIntegration.json()).secretReturned, false, "webhook secret must never be returned to the browser");
    const integrationStatus = await fetch(base + "/api/integrations/slack", { headers: workspaceHeaders });
    const integrationInfo = await integrationStatus.json();
    assert.equal(integrationInfo.configured, true);
    assert.equal(integrationInfo.encryptionReady, true);
    assert.equal(JSON.stringify(integrationInfo).includes("secret"), false, "integration status must not expose credentials");
    const testNotification = await fetch(base + "/api/integrations/slack/test", { method: "POST", headers: workspaceHeaders, body: "{}" });
    assert.equal(testNotification.status, 200, "owner should be able to send a test notification");
    assert.equal((await testNotification.json()).delivered, true);
    assert.equal(slackDeliveries.length, 1, "test endpoint should send one Slack notification");

    const guestResponse = await fetch(base + "/api/public/" + TENANT_ID + "/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "What time is breakfast?" }) });
    assert.equal(guestResponse.status, 200, "public guest chat should answer from approved tenant knowledge");
    const guestBody = await guestResponse.json();
    assert.match(guestBody.reply, /7 AM to 10 AM/);
    assert.ok(guestBody.conversationId);
    const guestHistory = await fetch(base + "/api/conversations/" + guestBody.conversationId, { headers: workspaceHeaders });
    assert.equal((await guestHistory.json()).messages.length, 2, "guest and assistant messages should be persisted");

    const escalationResponse = await fetch(base + "/api/public/" + TENANT_ID + "/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "I need a refund for my booking." }) });
    assert.equal(escalationResponse.status, 200, "sensitive guest requests should be safely escalated");
    const escalation = await escalationResponse.json();
    assert.equal(escalation.needsHuman, true);
    assert.equal(escalation.handoffStatus, "staff-queue");
    assert.equal(escalation.notificationStatus, "notified", "tenant Slack notification should be delivered for a handoff");
    assert.equal(slackDeliveries.length, 2, "guest escalation should trigger a tenant-specific Slack notification");
    assert.match(slackDeliveries[1].payload.text, /Guest message content was not forwarded/);
    assert.match(slackDeliveries[1].payload.text, new RegExp(escalation.conversationId));
    const guestFollowup = await fetch(base + "/api/public/" + TENANT_ID + "/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: escalation.conversationId, message: "Thank you, can someone please help me?" }) });
    assert.equal(guestFollowup.status, 200, "guest should be able to continue an existing conversation");
    const preservedQueue = await admin.query("SELECT status FROM conversations WHERE tenant_id = $1 AND id = $2", [TENANT_ID, escalation.conversationId]);
    assert.equal(preservedQueue.rows[0].status, "waiting_staff", "a guest follow-up must not silently remove an unresolved conversation from the staff queue");
    const retentionRead = await fetch(base + "/api/privacy/retention", { headers: workspaceHeaders });
    assert.equal((await retentionRead.json()).conversationRetentionDays, 90, "new workspaces should have a 90-day retention default");
    const retentionWrite = await fetch(base + "/api/privacy/retention", { method: "PATCH", headers: workspaceHeaders, body: JSON.stringify({ conversationRetentionDays: 30 }) });
    assert.equal(retentionWrite.status, 200, "workspace owner should be able to set retention");
    const oldConversation = (await admin.query("INSERT INTO conversations (tenant_id, channel, status, started_at, updated_at) VALUES ($1, 'website', 'resolved', now() - interval '40 days', now() - interval '40 days') RETURNING id", [TENANT_ID])).rows[0].id;
    await fetch(base + "/api/handoffs", { headers: workspaceHeaders });
    const oldConversationCheck = await admin.query("SELECT id FROM conversations WHERE tenant_id = $1 AND id = $2", [TENANT_ID, oldConversation]);
    assert.equal(oldConversationCheck.rowCount, 0, "expired conversations should be purged on workspace access");
    const retentionAudit = await admin.query("SELECT metadata FROM audit_events WHERE tenant_id = $1 AND action = 'conversations.retention_purged' ORDER BY created_at DESC LIMIT 1", [TENANT_ID]);
    assert.equal(retentionAudit.rows[0].metadata.deleted_count, 1, "retention purge should create an audit record");

    const handoffInbox = await fetch(base + "/api/handoffs", { headers: workspaceHeaders });
    assert.equal(handoffInbox.status, 200, "authenticated workspace staff should be able to load the handoff inbox");
    const inboxBody = await handoffInbox.json();
    assert.equal(inboxBody.delivery, "dashboard-queue-only", "the API must not imply external notification delivery");
    assert.ok(inboxBody.handoffs.some((item) => item.id === escalation.conversationId), "escalated guest conversation should appear in the staff queue");
    const resolveEscalation = await fetch(base + "/api/conversations/" + escalation.conversationId + "/status", { method: "PATCH", headers: workspaceHeaders, body: JSON.stringify({ status: "resolved" }) });
    assert.equal(resolveEscalation.status, 200, "staff should be able to resolve an escalated handoff");
    const deleteConversation = await fetch(base + "/api/conversations/" + escalation.conversationId, { method: "DELETE", headers: workspaceHeaders });
    assert.equal(deleteConversation.status, 200, "workspace owner should be able to permanently delete a conversation");
    assert.equal((await deleteConversation.json()).deleted, true);
    const deletedDetail = await fetch(base + "/api/conversations/" + escalation.conversationId, { headers: workspaceHeaders });
    assert.equal(deletedDetail.status, 404, "deleted conversation and its messages must no longer be accessible");
    const deleteAudit = await admin.query("SELECT action FROM audit_events WHERE tenant_id = $1 AND resource_id = $2 AND action = 'conversation.deleted'", [TENANT_ID, escalation.conversationId]);
    assert.equal(deleteAudit.rowCount, 1, "permanent deletion must leave an audit record");

    const removeIntegration = await fetch(base + "/api/integrations/slack", { method: "DELETE", headers: workspaceHeaders });
    assert.equal(removeIntegration.status, 200, "owner should be able to remove the Slack integration");
    const disabledStatus = await fetch(base + "/api/integrations/slack", { headers: workspaceHeaders });
    assert.equal((await disabledStatus.json()).configured, false);
    const emptyInbox = await fetch(base + "/api/handoffs", { headers: workspaceHeaders });
    assert.equal((await emptyInbox.json()).handoffs.some((item) => item.id === escalation.conversationId), false, "resolved handoffs should leave the active queue");

    const csrf = decodeURIComponent(csrfMatch[1]);
    const logout = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: cookies, "x-csrf-token": csrf, origin },
    });
    assert.equal(logout.status, 200, "CSRF-protected logout should revoke session");
    const afterLogout = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookies } });
    assert.equal(afterLogout.status, 401, "revoked session must no longer authenticate");
    const dashboardAfterLogout = await fetch(`${base}/dashboard.html`, { headers: { cookie: cookies }, redirect: "manual" });
    assert.equal(dashboardAfterLogout.status, 303, "revoked session must not open the dashboard");
    assert.equal(dashboardAfterLogout.headers.get("location"), "/login.html");

    process.stdout.write("PostgreSQL-backed login, tenant-scoped knowledge, conversations, guest chat, cross-tenant denial, dashboard gate, CSRF logout, and session revocation passed.\n");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (runtimePool) await runtimePool.end();
    try {
      await admin.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [[TENANT_ID, OTHER_TENANT_ID]]);
      await admin.query("DELETE FROM users WHERE id = $1", [USER_ID]);
      await admin.query(`DROP OWNED BY ${ROLE}`);
      await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
    } catch (error) {
      process.stderr.write(`Test cleanup warning: ${error.message}\n`);
    }
    await admin.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Authentication integration test failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
