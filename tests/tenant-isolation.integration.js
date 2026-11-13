import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

if (process.env.CI !== "true" || process.env.VEYRA_TENANT_TEST_DATABASE !== "true") {
  throw new Error("Refusing to run tenant integration tests outside the dedicated CI test database.");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for tenant integration tests.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : undefined,
});
const tag = randomUUID().replace(/-/g, "").slice(0, 10);
const port = 31000 + Math.floor(Math.random() * 20000);
const baseUrl = `http://127.0.0.1:${port}`;
const token = `ci-provision-${randomUUID()}`;
const tenants = [
  { name: `Veyra Tenant A ${tag}`, email: `tenant-a-${tag}@example.test`, password: `A-long-test-password-${tag}`, message: `PRIVATE MESSAGE FOR TENANT A ${tag}` },
  { name: `Veyra Tenant B ${tag}`, email: `tenant-b-${tag}@example.test`, password: `B-long-test-password-${tag}`, message: `PRIVATE MESSAGE FOR TENANT B ${tag}` },
];
let child;
let childOutput = "";
let serverReady = false;

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Veyra server exited early. ${childOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.database === "connected") return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Veyra server did not become database-ready. ${childOutput}`);
}

async function provision(tenant) {
  const response = await fetch(`${baseUrl}/api/platform/organizations`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Platform-Provisioning-Token": token },
    body: JSON.stringify({
      organizationName: tenant.name,
      email: tenant.email,
      password: tenant.password,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  tenant.slug = body.organization.slug;
}

async function login(tenant) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationSlug: tenant.slug,
      email: tenant.email,
      password: tenant.password,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  assert.match(cookie, /^veyra_session=/, "login must issue the expected session cookie");
  return cookie;
}

async function seedConversation(tenant) {
  const org = await pool.query("SELECT id FROM organizations WHERE slug=$1", [tenant.slug]);
  assert.equal(org.rowCount, 1);
  const conversation = await pool.query(
    "INSERT INTO conversations(organization_id,channel,status) VALUES($1,'website','open') RETURNING id",
    [org.rows[0].id],
  );
  tenant.conversationId = conversation.rows[0].id;
  await pool.query(
    "INSERT INTO messages(conversation_id,role,content) VALUES($1,'guest',$2)",
    [tenant.conversationId, tenant.message],
  );
}

async function readTranscript(cookie, conversationId) {
  return fetch(`${baseUrl}/api/admin/conversations/${conversationId}`, { headers: { cookie } });
}

async function csrfToken(cookie) {
  const response = await fetch(`${baseUrl}/api/auth/csrf`, { headers: { cookie } });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.csrfToken;
}

async function submitRevenue(cookie, csrf, event) {
  return fetch(`${baseUrl}/api/admin/revenue`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(event),
  });
}

async function readRevenue(cookie) {
  return fetch(`${baseUrl}/api/admin/revenue`, { headers: { cookie } });
}

async function seedKnowledge(tenant) {
  const org = await pool.query("SELECT id FROM organizations WHERE slug=$1", [tenant.slug]);
  const title = "Private policy " + tenant.name;
  const privateContent = "PRIVATE KNOWLEDGE FOR " + tenant.name;
  const inserted = await pool.query("INSERT INTO knowledge_documents(organization_id,title,category,content,approved) VALUES($1,$2,'general',$3,false) RETURNING id", [org.rows[0].id, title, privateContent]);
  tenant.knowledgeId = inserted.rows[0].id;
  await pool.query("INSERT INTO knowledge_document_versions(organization_id,document_id,title,category,content,approved,change_type) VALUES($1,$2,$3,'general',$4,false,'created')", [org.rows[0].id, tenant.knowledgeId, title, privateContent]);
}

async function readKnowledgeVersions(cookie, documentId) {
  return fetch(baseUrl + "/api/admin/knowledge/" + documentId + "/versions", { headers: { cookie } });
}

try {
  child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      DATABASE_SSL: "false",
      BOOTSTRAP_TOKEN: `bootstrap-${tag}`,
      PLATFORM_PROVISIONING_TOKEN: token,
      OPENAI_API_KEY: "",
      STAFF_WEBHOOK_URL: "",
      STAFF_WEBHOOK_SECRET: "",
      GUEST_DATA_STORAGE_ENABLED: "false",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { childOutput = (childOutput + chunk).slice(-5000); });
  await waitForServer();
  serverReady = true;

  for (const tenant of tenants) await provision(tenant);
  const [cookieA, cookieB] = await Promise.all(tenants.map(login));
  await Promise.all(tenants.map(seedConversation));
  await Promise.all(tenants.map(seedKnowledge));

  const ownA = await readTranscript(cookieA, tenants[0].conversationId);
  assert.equal(ownA.status, 200, "tenant A must read its own conversation");
  const ownABody = await ownA.json();
  assert.ok(ownABody.messages.some(message => message.content === tenants[0].message));

  const ownB = await readTranscript(cookieB, tenants[1].conversationId);
  assert.equal(ownB.status, 200, "tenant B must read its own conversation");
  const ownBBody = await ownB.json();
  assert.ok(ownBBody.messages.some(message => message.content === tenants[1].message));

  const crossAtoB = await readTranscript(cookieA, tenants[1].conversationId);
  assert.equal(crossAtoB.status, 404, "tenant A must not read tenant B's conversation");
  const crossBtoA = await readTranscript(cookieB, tenants[0].conversationId);
  assert.equal(crossBtoA.status, 404, "tenant B must not read tenant A's conversation");

  const ownKnowledgeA = await readKnowledgeVersions(cookieA, tenants[0].knowledgeId);
  assert.equal(ownKnowledgeA.status, 200, "tenant A must read its own knowledge history");
  const ownKnowledgeABody = await ownKnowledgeA.json();
  assert.ok(ownKnowledgeABody.versions.some(v => v.content === "PRIVATE KNOWLEDGE FOR " + tenants[0].name));
  const ownKnowledgeB = await readKnowledgeVersions(cookieB, tenants[1].knowledgeId);
  assert.equal(ownKnowledgeB.status, 200, "tenant B must read its own knowledge history");
  const ownKnowledgeBBody = await ownKnowledgeB.json();
  assert.ok(ownKnowledgeBBody.versions.some(v => v.content === "PRIVATE KNOWLEDGE FOR " + tenants[1].name));
  const crossKnowledgeAtoB = await readKnowledgeVersions(cookieA, tenants[1].knowledgeId);
  assert.equal(crossKnowledgeAtoB.status, 404, "tenant A must not read tenant B knowledge history");
  const crossKnowledgeBtoA = await readKnowledgeVersions(cookieB, tenants[0].knowledgeId);
  assert.equal(crossKnowledgeBtoA.status, 404, "tenant B must not read tenant A knowledge history");

  const [csrfA, csrfB] = await Promise.all([csrfToken(cookieA), csrfToken(cookieB)]);
  const linkedEvent = {
    type: "booking_confirmed",
    externalReference: `PMS-${tag}-BOOKING-A`,
    sourceReference: `Manager report / PMS export #${tag}`,
    amount: "250.50",
    currency: "EUR",
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    conversationId: tenants[0].conversationId,
  };
  const createA = await submitRevenue(cookieA, csrfA, linkedEvent);
  assert.equal(createA.status, 201, await createA.clone().text());
  const createdA = await createA.json();
  assert.equal(createdA.event.attribution_status, "veyra_linked_hotel_attested");
  assert.equal(createdA.event.amount_minor, "25050");
  const auditA = await pool.query(
    "SELECT count(*)::int AS count FROM audit_logs WHERE action='revenue.attested' AND target_id=$1",
    [createdA.event.id],
  );
  assert.equal(auditA.rows[0].count, 1, "accepted revenue must have an audit record");

  const duplicateA = await submitRevenue(cookieA, csrfA, linkedEvent);
  assert.equal(duplicateA.status, 409, "duplicate revenue references must be rejected");

  const crossTenantLink = await submitRevenue(cookieB, csrfB, {
    ...linkedEvent,
    externalReference: `PMS-${tag}-CROSS-TENANT`,
    conversationId: tenants[0].conversationId,
  });
  assert.equal(crossTenantLink.status, 400, "a hotel cannot link revenue to another hotel's conversation");

  const unlinkedEvent = {
    type: "addon_paid",
    externalReference: `PAY-${tag}-ADDON-B`,
    sourceReference: `Hotel manager payment reconciliation ${tag}`,
    amount: "75.00",
    currency: "USD",
    occurredAt: new Date(Date.now() - 30_000).toISOString(),
  };
  const createB = await submitRevenue(cookieB, csrfB, unlinkedEvent);
  assert.equal(createB.status, 201, await createB.clone().text());
  const createdB = await createB.json();
  assert.equal(createdB.event.attribution_status, "hotel_reported_unlinked");

  const [revenueA, revenueB] = await Promise.all([readRevenue(cookieA), readRevenue(cookieB)]);
  assert.equal(revenueA.status, 200);
  assert.equal(revenueB.status, 200);
  const revenueABody = await revenueA.json();
  const revenueBBody = await revenueB.json();
  assert.ok(revenueABody.events.some(event => event.external_reference === linkedEvent.externalReference));
  assert.ok(!revenueABody.events.some(event => event.external_reference === unlinkedEvent.externalReference));
  assert.ok(revenueBBody.events.some(event => event.external_reference === unlinkedEvent.externalReference));
  assert.ok(!revenueBBody.events.some(event => event.external_reference === linkedEvent.externalReference));
  assert.equal(revenueABody.linkedTotals.reduce((n, item) => n + Number(item.event_count), 0), 1);
  assert.equal(revenueBBody.linkedTotals.reduce((n, item) => n + Number(item.event_count), 0), 0);
  assert.equal(revenueBBody.unlinkedTotals.reduce((n, item) => n + Number(item.event_count), 0), 1);

  const missingCsrf = await fetch(`${baseUrl}/api/admin/revenue`, {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/json" },
    body: JSON.stringify(linkedEvent),
  });
  assert.equal(missingCsrf.status, 403, "revenue writes must require CSRF verification");

  const deleteConversation = await fetch(`${baseUrl}/api/admin/conversations/${tenants[0].conversationId}`, {
    method: "DELETE",
    headers: { cookie: cookieA, "X-CSRF-Token": csrfA },
  });
  assert.equal(deleteConversation.status, 200, "owners must be able to delete their own conversation");
  const afterDelete = await readRevenue(cookieA);
  assert.equal(afterDelete.status, 200);
  const afterDeleteBody = await afterDelete.json();
  const deletedConversationEvent = afterDeleteBody.events.find(event => event.external_reference === linkedEvent.externalReference);
  assert.equal(deletedConversationEvent.conversation_id, null);
  assert.equal(deletedConversationEvent.attribution_status, "hotel_reported_unlinked");
  assert.equal(afterDeleteBody.linkedTotals.reduce((n, item) => n + Number(item.event_count), 0), 0);


  console.log("PASS: tenant-scoped transcripts, knowledge history and revenue evidence verified for two hotel workspaces.");

} finally {
  if (serverReady) {
    for (const tenant of tenants) {
      if (tenant.slug) {
        await pool.query("DELETE FROM organizations WHERE slug=$1", [tenant.slug]).catch(() => {});
      }
    }
  }
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }
  await pool.end();
}
