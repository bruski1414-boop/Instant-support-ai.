import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import knowledgeLoader from "../hotel-knowledge.js";
const { loadApprovedKnowledge } = knowledgeLoader;
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
  tenant.csrfToken = body.csrfToken;
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
  return fetch(`${baseUrl}/api/admin/conversations/${conversationId}`, {
    headers: { cookie },
  });
}

async function seedKnowledge(tenant) {
  const org = await pool.query("SELECT id FROM organizations WHERE slug=$1", [tenant.slug]);
  const title = "Private policy " + tenant.name;
  const privateContent = "PRIVATE KNOWLEDGE FOR " + tenant.name;
  const inserted = await pool.query("INSERT INTO knowledge_documents(organization_id,title,category,content,approved) VALUES($1,$2,'general',$3,false) RETURNING id", [org.rows[0].id, title, privateContent]);
  tenant.knowledgeId = inserted.rows[0].id;
  tenant.privateKnowledge = privateContent;
  tenant.approvedKnowledge = "APPROVED KNOWLEDGE FOR " + tenant.name;
  const approved = await pool.query("INSERT INTO knowledge_documents(organization_id,title,category,content,approved) VALUES($1,$2,'general',$3,true) RETURNING id", [org.rows[0].id, "Approved policy " + tenant.name, tenant.approvedKnowledge]);
  tenant.approvedKnowledgeId = approved.rows[0].id;
  await pool.query("INSERT INTO knowledge_documents(organization_id,title,category,content,approved,review_due_at) VALUES($1,$2,'general',$3,true,CURRENT_DATE - INTERVAL '1 day')", [org.rows[0].id, "Expired policy " + tenant.name, "EXPIRED KNOWLEDGE FOR " + tenant.name]);
  await pool.query("INSERT INTO knowledge_document_versions(organization_id,document_id,title,category,content,approved,change_type) VALUES($1,$2,$3,'general',$4,false,'created')", [org.rows[0].id, tenant.knowledgeId, title, privateContent]);
}

async function readKnowledgeVersions(cookie, documentId) {
  return fetch(baseUrl + "/api/admin/knowledge/" + documentId + "/versions", { headers: { cookie } });
}

async function seedStorageConnection(tenant, provider) {
  const org = await pool.query("SELECT id FROM organizations WHERE slug=$1", [tenant.slug]);
  const organizationId = org.rows[0].id;
  const email = "storage-" + tenant.email;
  await pool.query(
    "INSERT INTO storage_connections(organization_id,provider,account_email,encrypted_tokens,status,connected_by) VALUES($1,'google',$2,'test-encrypted-token','connected',(SELECT id FROM users WHERE organization_id=$1 AND email=$3))",
    [organizationId, email, tenant.email]
  );
  await pool.query(
    "INSERT INTO organization_storage_connections(organization_id,provider,workspace_reference,status,scopes,connected_by,connected_at,last_sync_status) VALUES($1,$2,$3,'connected',ARRAY['drive.readonly'],(SELECT id FROM users WHERE organization_id=$1 AND email=$4),now(),'never')",
    [organizationId, provider, email, tenant.email]
  );
}

async function readStorageConnections(cookie) {
  return fetch(baseUrl + "/api/admin/storage/connections", { headers: { cookie } });
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
  await Promise.all([
    seedStorageConnection(tenants[0], "google_drive"),
    seedStorageConnection(tenants[1], "microsoft_sharepoint"),
  ]);

  const storageA = await readStorageConnections(cookieA);
  assert.equal(storageA.status, 200);
  const storageABody = await storageA.json();
  assert.deepEqual(storageABody.connections.map(connection => connection.provider), ["google"]);
  assert.equal(storageABody.connections[0].account_email, "storage-" + tenants[0].email);
  assert.equal(Object.hasOwn(storageABody.connections[0], "encrypted_tokens"), false, "storage tokens must never be returned by the dashboard API");
  assert.equal(JSON.stringify(storageABody).includes("test-encrypted-token"), false, "storage token ciphertext must never be exposed");
  assert.equal(JSON.stringify(storageABody).includes(tenants[1].email), false, "tenant A must not see tenant B's storage account");
  const storageB = await readStorageConnections(cookieB);
  assert.equal(storageB.status, 200);
  const storageBBody = await storageB.json();
  assert.deepEqual(storageBBody.connections.map(connection => connection.provider), ["google"]);
  assert.equal(storageBBody.connections[0].account_email, "storage-" + tenants[1].email);
  assert.equal(JSON.stringify(storageBBody).includes(tenants[0].email), false, "tenant B must not see tenant A's storage account");

  const crossDisconnect = await fetch(baseUrl + "/api/admin/storage/connections/microsoft", {
    method: "DELETE",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken },
  });
  assert.equal(crossDisconnect.status, 200, "disconnecting an unowned provider should safely report no local connection");
  const storageBAfter = await readStorageConnections(cookieB);
  assert.equal(storageBAfter.status, 200);
  const storageBAfterBody = await storageBAfter.json();
  assert.equal(storageBAfterBody.connections[0].account_email, "storage-" + tenants[1].email, "tenant A must not disconnect tenant B's storage connection");

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

  const orgA = (await pool.query("SELECT id FROM organizations WHERE slug=$1", [tenants[0].slug])).rows[0].id;
  const orgB = (await pool.query("SELECT id FROM organizations WHERE slug=$1", [tenants[1].slug])).rows[0].id;
  const approvedA = await loadApprovedKnowledge(pool, orgA);
  const approvedB = await loadApprovedKnowledge(pool, orgB);
  assert.equal(approvedA.rows.length, 1, "tenant A guest context must include only its current approved document");
  assert.equal(approvedB.rows.length, 1, "tenant B guest context must include only its current approved document");
  assert.equal(approvedA.rows[0].content, tenants[0].approvedKnowledge);
  assert.equal(approvedB.rows[0].content, tenants[1].approvedKnowledge);
  assert.equal(JSON.stringify(approvedA.rows).includes(tenants[0].privateKnowledge), false, "unapproved tenant A knowledge must never enter guest context");
  assert.equal(JSON.stringify(approvedA.rows).includes("EXPIRED KNOWLEDGE"), false, "expired tenant A knowledge must never enter guest context");
  assert.equal(JSON.stringify(approvedA.rows).includes(tenants[1].approvedKnowledge), false, "tenant A guest context must never include tenant B knowledge");
  assert.equal(JSON.stringify(approvedB.rows).includes(tenants[0].approvedKnowledge), false, "tenant B guest context must never include tenant A knowledge");

  const crossEdit = await fetch(baseUrl + "/api/admin/knowledge/" + tenants[1].approvedKnowledgeId, {
    method: "PATCH",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken, "content-type": "application/json" },
    body: JSON.stringify({ content: "Unauthorized cross-hotel edit attempt" }),
  });
  assert.equal(crossEdit.status, 404, "tenant A must not edit tenant B's approved knowledge");
  const ownEdit = await fetch(baseUrl + "/api/admin/knowledge/" + tenants[0].approvedKnowledgeId, {
    method: "PATCH",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken, "content-type": "application/json" },
    body: JSON.stringify({ content: "Updated policy content requiring fresh approval" }),
  });
  assert.equal(ownEdit.status, 200, "tenant A must be able to update its own knowledge");
  const ownEditBody = await ownEdit.json();
  assert.equal(ownEditBody.document.approved, false, "editing approved content must automatically revoke approval");
  const afterEditA = await loadApprovedKnowledge(pool, orgA);
  assert.equal(afterEditA.rows.length, 0, "edited content must not return to guest context before reapproval");
  const afterEditB = await loadApprovedKnowledge(pool, orgB);
  assert.equal(afterEditB.rows.length, 1, "editing tenant A content must not affect tenant B guest context");

  const crossDelete = await fetch(baseUrl + "/api/admin/knowledge/" + tenants[1].knowledgeId, {
    method: "DELETE",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken },
  });
  assert.equal(crossDelete.status, 404, "tenant A must not delete tenant B's knowledge");
  const ownDelete = await fetch(baseUrl + "/api/admin/knowledge/" + tenants[0].knowledgeId, {
    method: "DELETE",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken },
  });
  assert.equal(ownDelete.status, 200, "tenant A must be able to delete its own knowledge");
  const deletedA = await pool.query("SELECT id FROM knowledge_documents WHERE id=$1 AND organization_id=$2", [tenants[0].knowledgeId, orgA]);
  const preservedB = await pool.query("SELECT id FROM knowledge_documents WHERE id=$1 AND organization_id=$2", [tenants[1].knowledgeId, orgB]);
  assert.equal(deletedA.rowCount, 0, "tenant A's selected document must be deleted");
  assert.equal(preservedB.rowCount, 1, "tenant A deletion must not affect tenant B's document");
  console.log("PASS: tenant-scoped transcripts, knowledge read/edit/delete, approval invalidation, approved guest context and storage connections verified for two hotel workspaces.");
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
