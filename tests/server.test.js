const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const vm = require("node:vm");
let child;
let baseUrl;
async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
before(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "", ALLOWED_ORIGINS: "http://localhost:3000" }, stdio: "ignore" });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Veyra server exited before tests started");
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok || response.status === 503) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Veyra server did not become ready");
});
after(() => { if (child && child.exitCode === null) child.kill("SIGTERM"); });
test("health endpoint reports demo mode when no API key is configured", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.equal(body.readyForPilot, false);
  assert.equal(body.checks.databaseConnected, false);
  assert.equal(body.checks.aiConfigured, false);
  assert.equal(body.mode, "demo-no-api-key");
  assert.equal(body.humanHandoff, "not-configured");
  assert.equal(body.guestDataStorage, false);
  assert.equal(body.database, "not-configured");
});
test("pilot readiness remains blocked separately from process health", async () => {
  const response = await fetch(`${baseUrl}/api/readiness`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.status, "not-ready");
  assert.equal(body.readyForPilot, false);
});
test("chat rejects an empty message", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "   " }) });
  assert.equal(response.status, 400);
});
test("chat rejects malformed conversation history", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hello", history: "not-an-array" }) });
  assert.equal(response.status, 400);
});
test("chat rejects messages above the documented size limit", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "x".repeat(4001) }) });
  assert.equal(response.status, 413);
});
test("chat does not pretend to be live when the provider key is missing", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "What time is breakfast?" }) });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.demo, true);
  assert.equal(body.handoffConfigured, false);
});

test("dashboard and guest widget JavaScript parse cleanly", () => {
  const html = fs.readFileSync("dashboard.html", "utf8");
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>", start);
  assert.ok(start >= 0 && end > start, "dashboard inline script exists");
  new vm.Script(html.slice(start + 8, end));
  new vm.Script(fs.readFileSync("widget.js", "utf8"));
});
test("tenant chat fails closed when database is not configured", async () => {
  const response = await fetch(`${baseUrl}/api/public/sample-hotel/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What time is breakfast?" })
  });
  assert.equal(response.status, 503);
});

test("organization bootstrap fails closed when database is not configured", async () => {
  const response = await fetch(`${baseUrl}/api/setup/organization`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationName: "Sample Hotel", email: "owner@example.com", password: "a-long-test-password" })
  });
  assert.equal(response.status, 503);
});

test("public hotel chat has a dedicated abuse limit", async () => {
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = await fetch(`${baseUrl}/api/public/sample-hotel/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What time is breakfast?" })
    });
  }
  assert.equal(last.status, 429);
});

test("initial workspace bootstrap has a dedicated attempt limit", async () => {
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await fetch(`${baseUrl}/api/setup/organization`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationName: "Sample Hotel", email: "owner@example.com", password: "a-long-test-password" })
    });
  }
  assert.equal(last.status, 429);
});

test("guest widget reuses its server-issued conversation id", () => {
  const widget = fs.readFileSync("widget.js", "utf8");
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(widget, /conversationId:conversationId/);
  assert.match(widget, /conversationToken:conversationToken/);
  assert.match(server, /guest_token_hash=\$3/);
  assert.match(server, /hash\(requestedToken\)/);
  assert.match(widget, /conversationId=data\.conversationId\|\|conversationId/);
  assert.match(server, /WHERE id=\$1 AND organization_id=\$2/);
  assert.match(server, /LIMIT 8/);
  assert.match(server, /requestedConversation!==null/);
});

test("conversation deletion fails closed without a database", async () => {
  const response = await fetch(`${baseUrl}/api/admin/conversations/123e4567-e89b-42d3-a456-426614174000`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(response.status, 503);
});

test("conversation deletion is tenant scoped and owner controlled", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /app\.delete\("\/api\/admin\/conversations\/:id",requireDb,auth,role\("owner","admin"\)/);
  assert.match(server, /DELETE FROM conversations WHERE id=\$1 AND organization_id=\$2/);
  assert.match(server, /conversation\.deleted/);
  assert.match(dashboard, /delete-conversation/);
});

test("conversation transcript endpoint fails closed without a database", async () => {
  const response = await fetch(`${baseUrl}/api/admin/conversations/123e4567-e89b-42d3-a456-426614174000`);
  assert.equal(response.status, 503);
});

test("conversation transcript reads are tenant scoped", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /app\.get\("\/api\/admin\/conversations\/:id",requireDb,auth/);
  assert.match(server, /SELECT id,status,channel,started_at,last_message_at FROM conversations WHERE id=\$1 AND organization_id=\$2/);
  assert.match(server, /messages:m\.rows\.reverse\(\)/);
  assert.match(dashboard, /view-conversation/);
});

test("public file serving exposes only the intended frontend assets", async () => {
  const widget = await fetch(`${baseUrl}/widget.js`);
  const source = await fetch(`${baseUrl}/server.js`);
  const docs = await fetch(`${baseUrl}/README.md`);
  assert.equal(widget.status, 200);
  assert.equal(source.status, 404);
  assert.equal(docs.status, 404);
  assert.equal(widget.headers.get("x-content-type-options"), "nosniff");
  assert.equal(widget.headers.get("x-frame-options"), "DENY");
});

test("sign-in is scoped to a hotel workspace", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /organizationSlug/);
  assert.match(server, /JOIN organizations o ON o\.id=u\.organization_id/);
  assert.match(server, /o\.slug=\$2/);
  assert.match(dashboard, /id="workspaceSlug"/);
});

test("first-owner bootstrap serializes competing setup requests", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /pg_advisory_xact_lock\(20261111\)/);
});

test("editing approved hotel knowledge requires reapproval", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /contentChanged\?false:Boolean\(v\.approved\)/);
  assert.match(server, /knowledge\.edited_unapproved/);
  assert.match(server, /typeof body\.approved!=="boolean"/);
  assert.match(server, /body\.content\.length>12000/);
  assert.match(server, /Set a review date of today or later before approving hotel knowledge/);
  assert.match(server, /isValidReviewDueDate/);
});


test("retention policy is tenant-controlled, disabled by default and requires explicit cleanup confirmation", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /conversation_retention_days INTEGER NOT NULL DEFAULT 0/);
  assert.match(server, /app\.put\("\/api\/admin\/retention",requireDb,auth,role\("owner","admin"\)/);
  assert.match(server, /app\.post\("\/api\/admin\/retention\/cleanup",requireDb,auth,role\("owner","admin"\)/);
  assert.match(server, /q\.body\?\.confirm!==true/);
  assert.match(server, /c\.status='resolved'/);
  assert.match(server, /e\.status<>'resolved'/);
  assert.match(dashboard, /id="retentionDays"/);
  assert.match(dashboard, /id="runRetention"/);
  assert.match(dashboard, /Permanently delete eligible resolved conversations/);
});

test("health endpoint cannot report pilot readiness with missing prerequisites", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(body.readyForPilot, false);
  assert.deepEqual(body.checks, {
    databaseConnected: false,
    aiConfigured: false,
    guestDataStorageEnabled: false,
    staffWebhookConfigured: false,
    durableBackupsVerified: false,
    tenantIsolationTestsPassed: false,
    providerOAuthTested: false,
    hotelPrivacyApproved: false,
    staffHandoffTested: false,
    pilotReleaseApproved: false,
  });
});

test("knowledge documents retain tenant-scoped version history", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(server, /CREATE TABLE IF NOT EXISTS knowledge_document_versions/);
  assert.match(server, /knowledge_document_versions WHERE document_id=\$1 AND organization_id=\$2/);
  assert.match(server, /change_type/);
  assert.match(dashboard, /history-knowledge/);
  assert.match(dashboard, /knowledgeHistory/);
});

test("guest conversation writes lock and revalidate the tenant-owned conversation before appending messages", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /SELECT id FROM conversations WHERE id=\$1 AND organization_id=\$2 AND guest_token_hash=\$3 FOR UPDATE/);
  assert.match(server, /UPDATE conversations SET last_message_at=now\(\),status=CASE WHEN \$2 THEN 'escalated' WHEN status='resolved' THEN 'open' ELSE status END WHERE id=\$1 AND organization_id=\$3/);
});


test("staff handoff events carry stable tenant identifiers for multi-hotel routing", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dispatcher = fs.readFileSync("staff-notifications.js", "utf8");
  assert.match(dispatcher, /organizationId: organization\.id/);
  assert.match(dispatcher, /organizationSlug: organization\.slug/);
  assert.match(server, /deliverStaffEscalation/);
  assert.match(server, /o\.id AS organization_id,o\.name,o\.slug FROM escalations e JOIN organizations o ON o\.id=e\.organization_id/);
  assert.match(server, /notify\(\{id:item\.organization_id,name:item\.name,slug:item\.slug\}/);
});


test("hotel website origins are allowed dynamically from each tenant's saved HTTPS profile", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /JOIN organization_settings s ON s\.organization_id=o\.id WHERE o\.slug=\$1 AND s\.website_url=\$2/);
  assert.match(server, /u\.protocol==="https:"&&u\.origin===p\.website_url/);
});

test("public guest chat requires fresh tenant-specific AI, staff and storage verification", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /verified_at>now\(\)-interval '30 days'/);
  assert.match(server, /verifiedForHotel\.has\("ai_provider"\)/);
  assert.match(server, /verifiedForHotel\.has\("staff_webhook"\)/);
  assert.match(server, /FROM organization_storage_connections WHERE organization_id=\$1 AND status='connected'/);
  assert.match(server, /This hotel's AI and staff notification integrations must be verified/);
  assert.match(server, /This hotel must connect and authorize its own storage provider/);
});

test("AI and staff integrations require live verification before onboarding marks them complete", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /organization_integration_checks/);
  assert.match(server, /ai\.models\.retrieve\(MODEL/);
  assert.match(server, /veyra\.integration\.test/);
  assert.match(server, /verified_at,verified_by/);
  assert.match(server, /handoffVerified=Boolean\(handoffConfigured&&verified\.staff_webhook\)/);
  assert.match(server, /organization_staff_webhooks WHERE organization_id=\$1/);
  assert.match(server, /decryptWebhookConfig\(saved\.rows\[0\]\.encrypted_config/);
});


test("hotel setup dashboard exposes AI and staff dispatcher verification actions", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /id="testAiIntegration"/);
  assert.match(dashboard, /id="testStaffIntegration"/);
  assert.match(dashboard, /api\("\/api\/admin\/integrations\/test-/);
  assert.match(dashboard, /Hotel-specific signed test event accepted/);
});


test("hotel profile email validation accepts ordinary staff email addresses", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.ok(server.includes(String.raw`if(email&&!/^[-.+\w]+@[-.\w]+\.[A-Za-z]{2,}$/.test(email))`));
});


test("provider import purge requires explicit confirmation and deletes only this hotel's provider-sourced knowledge and versions", () => {
  const storage = fs.readFileSync("storage-integrations.js", "utf8");
  assert.match(storage, /router\.delete\("\/imports\/:provider", auth, role\("owner", "admin"\)/);
  assert.match(storage, /req\.body\?\.confirm !== true/);
  assert.match(storage, /WHERE organization_id=\$1 AND source_reference LIKE \$2 FOR UPDATE/);
  assert.match(storage, /DELETE FROM knowledge_document_versions WHERE organization_id=\$1 AND document_id=ANY\(\$2::uuid\[\]\)/);
  assert.match(storage, /DELETE FROM knowledge_documents WHERE organization_id=\$1 AND id=ANY\(\$2::uuid\[\]\)/);
  assert.match(storage, /storage\." \+ provider \+ "\.imported_copies_purged/);
});


test("hotel storage dashboard distinguishes disconnect from explicit imported-copy deletion", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /data-storage-purge="google"/);
  assert.match(dashboard, /data-storage-purge="microsoft"/);
  assert.match(dashboard, /PERMANENTLY delete this hotel's imported/);
  assert.match(dashboard, /api\("\/api\/admin\/storage\/imports\/"\+b\.dataset\.storagePurge/);
  assert.match(dashboard, /Existing imported knowledge copies will remain in Veyra until separately deleted/);
});

test("staff notification retries are capped and direct staff to manual fallback", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /if\(item\.notification_attempts>=5\)return r\.status\(429\)/);
  assert.match(server, /Notification retry limit reached\. Use the hotel manual staff contact process\./);
  assert.match(server, /notification_attempts=notification_attempts\+CASE WHEN \$2 THEN 1 ELSE 0 END/);
  assert.match(server, /notification_status===\"delivered\"\)return r\.status\(409\)/);
});


test("staff handoff dashboard makes failed and unconfigured notifications require manual follow-up", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /No staff notification configured — contact hotel staff manually/);
  assert.match(dashboard, /Delivery failed — contact hotel staff manually now/);
  assert.match(dashboard, /Retry limit reached — contact hotel staff manually now/);
  assert.match(dashboard, /Manual follow-up must not be skipped/);
  assert.match(dashboard, /notification_last_attempt_at/);
  assert.match(dashboard, /notification==="failed"&&!exhausted/);
});

test("guest chat converts AI provider failures into a persisted staff handoff instead of losing the request", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /catch\(error\)\{console\.error\("Guest support AI request failed:"/);
  assert.match(server, /resolvedAnswer=createAiUnavailableAnswer\(\)/);
  assert.match(server, /const \{generateGuestSupportAnswer,createAiUnavailableAnswer\}=require\("\.\/guest-support-engine"\)/);
  assert.match(server, /const flagHuman=resolvedAnswer\.needsHuman/);
});


test("staff webhook configuration is encrypted, tenant-scoped and verified before use", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  const security = fs.readFileSync("staff-webhook-security.js", "utf8");
  assert.match(server, /CREATE TABLE IF NOT EXISTS organization_staff_webhooks\(organization_id UUID PRIMARY KEY/);
  assert.match(server, /app\.put\("\/api\/admin\/integrations\/staff-webhook",requireDb,auth,role\("owner","admin"\)/);
  assert.match(server, /app\.delete\("\/api\/admin\/integrations\/staff-webhook",requireDb,auth,role\("owner","admin"\)/);
  assert.match(server, /app\.get\("\/api\/admin\/integrations\/staff-webhook",requireDb,auth,role\("owner","admin"\)/);
  assert.match(server, /DELETE FROM organization_integration_checks WHERE organization_id=\$1 AND integration='staff_webhook'/);
  assert.match(server, /postSignedWebhook\(config\.url,config\.secret,event/);
  assert.match(security, /aes-256-gcm/);
  assert.match(security, /resolvePublicWebhook/);
  assert.match(security, /agent:false/);
  assert.match(dashboard, /id="staffWebhookForm"/);
  assert.match(dashboard, /id="staffWebhookSecret"/);
});

test("revenue dashboard counts every attributed enquiry and calculates conversion rate", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /Total guest enquiries/);
  assert.match(dashboard, /id="revenueConversionRate"/);
  assert.match(dashboard, /const enquiries=totals\.reduce\(/);
  assert.match(dashboard, /const conversions=totals\.filter\(x=>x\.status==="converted"\)/);
  assert.match(dashboard, /\(conversions\/enquiries\)\*100/);
  assert.match(dashboard, /enquiries\?\(/);
});

test("conversation insights endpoint uses organization-scoped aggregate data without returning message text", () => {
  const server = fs.readFileSync("server.js", "utf8");
  assert.match(server, /app\.get\("\/api\/admin\/insights",requireDb,auth/);
  assert.match(server, /c\.organization_id=\$1/);
  assert.match(server, /m\.role='guest'/);
  assert.match(server, /count\(DISTINCT m\.conversation_id\)/);
  assert.match(server, /interval '30 days'/);
  assert.match(server, /handoffTopics:handoffs\.rows/);
  assert.match(server, /daily:daily\.rows/);
  assert.doesNotMatch(server.slice(server.indexOf('app.get("/api/admin/insights"'), server.indexOf('app.get("/api/admin/offers"')), /SELECT[^\n]*m\.content[^\n]*AS\s+(message|guest_message)/i);
});

test("conversation insights dashboard offers cautious manager actions from handoff categories", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /id="insightRecommendations"/);
  assert.match(dashboard, /Suggested manager checks/);
  assert.match(dashboard, /not proof that hotel information is missing/);
  assert.match(dashboard, /Availability unclear/);
  assert.match(dashboard, /Policy or payment review/);
  assert.match(dashboard, /Complaint or sensitive request/);
  assert.match(dashboard, /Other staff handoffs/);
});

test("conversation insights compare guest topics with tenant-scoped approved knowledge document counts", () => {
  const server = fs.readFileSync("server.js", "utf8");
  const route = server.slice(server.indexOf('app.get("/api/admin/insights"'), server.indexOf('app.get("/api/admin/offers"'));
  assert.match(route, /FROM knowledge_documents WHERE organization_id=\$1 GROUP BY category/);
  assert.match(route, /approved=true AND review_due_at IS NOT NULL AND review_due_at>=CURRENT_DATE/);
  assert.match(route, /review_due_at IS NULL OR review_due_at<CURRENT_DATE/);
  assert.match(route, /documents_needing_review/);
  assert.match(route, /knowledgeCoverage/);
  assert.match(route, /approved_documents/);
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /Knowledge coverage check/);
  assert.match(dashboard, /id="insightKnowledgeCoverage"/);
  assert.match(dashboard, /does not prove that it answers every guest question/);
});

test("knowledge review centre provides document search, status and category filters with approval totals", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /id="knowledgeTotal"/);
  assert.match(dashboard, /id="knowledgeApproved"/);
  assert.match(dashboard, /id="knowledgePending"/);
  assert.match(dashboard, /id="knowledgeOverdue"/);
  assert.match(dashboard, /id="knowledgeSearch"/);
  assert.match(dashboard, /id="knowledgeStatusFilter"/);
  assert.match(dashboard, /id="knowledgeCategoryFilter"/);
  assert.match(dashboard, /function renderKnowledgeReview\(\)/);
  assert.match(dashboard, /Approve after verification/);
  assert.match(dashboard, /Approval is never automatic/);
});

test("knowledge review centre flags review dates due within fourteen days separately from overdue documents", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /id="knowledgeDueSoon"/);
  assert.match(dashboard, /value="due-soon"/);
  assert.match(dashboard, /daysUntilDue>=0&&daysUntilDue<=14/);
  assert.match(dashboard, /status==="due-soon"&&state.dueSoon/);
  assert.match(dashboard, /review due soon/);
  assert.match(dashboard, /not an email notification/);
});

test("manager notification centre aggregates staff handoffs, knowledge reviews and offer expiry without guest message content", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /id="notificationCount"/);
  assert.match(dashboard, /id="notificationHandoffs"/);
  assert.match(dashboard, /id="notificationKnowledge"/);
  assert.match(dashboard, /id="notificationOffers"/);
  assert.match(dashboard, /async function loadNotificationCentre\(\)/);
  assert.match(dashboard, /api\("\/api\/admin\/escalations"\)/);
  assert.match(dashboard, /api\("\/api\/admin\/knowledge"\)/);
  assert.match(dashboard, /api\("\/api\/admin\/offers"\)/);
  assert.match(dashboard, /notification_status/);
  assert.match(dashboard, /status!=="delivered"&& \(status==="failed"\|\|status==="not_configured"/);
  assert.match(dashboard, /daysUntil\(x\.expires_at\)<=7/);
  assert.match(dashboard, /data-panel=/);
  assert.match(dashboard, /No manager action items detected/);
});

test("performance report separates rolling conversation metrics from all-time staff-confirmed sales", () => {
  const dashboard = fs.readFileSync("dashboard.html", "utf8");
  assert.match(dashboard, /data-panel="performance"/);
  assert.match(dashboard, /id="performanceDaily"/);
  assert.match(dashboard, /async function loadPerformanceReport\(\)/);
  assert.match(dashboard, /api\("\/api\/admin\/insights"\)/);
  assert.match(dashboard, /api\("\/api\/admin\/offer-attributions"\)/);
  assert.match(dashboard, /All-time recorded attributions/);
  assert.match(dashboard, /does not claim that Veyra caused incremental revenue/);
  assert.match(dashboard, /id="performanceRate"/);
  assert.match(dashboard, /id="performanceRevenue"/);
});

test("AI response latency is measured at generation and aggregated per tenant", () => {
 const server=fs.readFileSync("server.js","utf8");
 const dashboard=fs.readFileSync("dashboard.html","utf8");
 assert.match(server,/ALTER TABLE messages ADD COLUMN IF NOT EXISTS response_time_ms INTEGER/);
 assert.match(server,/process\.hrtime\.bigint\(\)/);
 assert.match(server,/response_time_ms\) VALUES\(\$1,'guest',\$2,NULL\),\(\$1,'assistant',\$3,\$4\)/);
 assert.match(server,/percentile_cont\(0\.5\) WITHIN GROUP\(ORDER BY response_time_ms\)/);
 assert.match(server,/percentile_cont\(0\.95\) WITHIN GROUP\(ORDER BY response_time_ms\)/);
 assert.match(server,/c\.organization_id=\$1 AND m\.role='assistant'/);
 assert.match(server,/responseLatency:responseLatency\.rows\[0\]/);
 assert.match(dashboard,/id="performanceLatencyCount"/);
 assert.match(dashboard,/id="performanceLatencyMedian"/);
 assert.match(dashboard,/id="performanceLatencyP95"/);
 assert.match(dashboard,/does not measure knowledge retrieval, database writes, delivery to the guest, or staff response time/);
});

test("staff handoff replies are tenant-scoped, audited and record first response time once", () => {
 const server=fs.readFileSync("server.js","utf8");
 assert.match(server,/ALTER TABLE escalations ADD COLUMN IF NOT EXISTS first_staff_response_at TIMESTAMPTZ/);
 assert.match(server,/app\.post\("\/api\/admin\/escalations\/:id\/reply",requireDb,auth,role\("owner","admin","staff"\)/);
 assert.match(server,/SELECT id,conversation_id,status,created_at,first_staff_response_at FROM escalations WHERE id=\$1 AND organization_id=\$2 FOR UPDATE/);
 assert.match(server,/INSERT INTO messages\(conversation_id,role,content\) VALUES\(\$1,'staff',\$2\)/);
 assert.match(server,/first_staff_response_at=COALESCE\(first_staff_response_at,now\(\)\)/);
 assert.match(server,/escalation\.staff_reply_sent/);
 assert.match(server,/staffResponseLatency:staffResponseLatency\.rows\[0\]/);
 assert.match(server,/staffWorkload:staffWorkload\.rows/);
 assert.match(server,/COALESCE\(msg\.recent_messages,'\[\]'::json\) AS recent_messages/);
 assert.match(server,/SELECT role,content,created_at FROM messages WHERE conversation_id=e\.conversation_id ORDER BY created_at DESC LIMIT 8/);

 assert.match(server,/LEFT JOIN users u ON u\.id=e\.assigned_to AND u\.organization_id=e\.organization_id/);
 assert.match(server,/e\.organization_id=\$1 AND \(e\.created_at>=now\(\)-interval '30 days' OR e\.status IN \('open','claimed'\)\)/);
 assert.match(server,/AS currently_open/);
 assert.match(server,/AS resolved_30d/);
 const dashboardHtml=fs.readFileSync("dashboard.html","utf8");
 assert.match(dashboardHtml,/id="performanceStaffWorkload"/);
 assert.match(dashboardHtml,/Handoffs · 30d/);
 assert.match(dashboardHtml,/Unassigned handoffs are shown separately/);
 assert.match(dashboardHtml,/id="handoffSearch"/);
 assert.match(dashboardHtml,/id="handoffFilter"/);
 assert.match(dashboardHtml,/RECENT CONVERSATION/);
 assert.match(dashboardHtml,/recent_messages/);


 assert.match(dashboardHtml,/id="performanceStaffCount"/);
 assert.match(dashboardHtml,/id="performanceStaffMedian"/);
 assert.match(dashboardHtml,/id="performanceStaffP95"/);
 assert.match(dashboardHtml,/data-action="send-staff-reply"/);
 assert.match(dashboardHtml,/api\("\/api\/admin\/escalations\/".*\/reply/);

 assert.match(server,/percentile_cont\(0\.95\) WITHIN GROUP\(ORDER BY EXTRACT\(EPOCH FROM \(first_staff_response_at-created_at\)\)\*1000\)/);
});
