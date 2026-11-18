import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import knowledgeLoader from "../hotel-knowledge.js";
const { loadApprovedKnowledge } = knowledgeLoader;
import pmsIntegration from "../pms-integration.js";
const { recordWebhookEvent } = pmsIntegration;
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
  const email = "storage-" + provider + "-" + tenant.email;
  const organizationProvider = provider === "google" ? "google_drive" : "microsoft_sharepoint";
  const scope = provider === "google" ? "drive.readonly" : "Files.Read.All";
  await pool.query(
    "INSERT INTO storage_connections(organization_id,provider,account_email,encrypted_tokens,status,connected_by) VALUES($1,$2,$3,'test-encrypted-token','connected',(SELECT id FROM users WHERE organization_id=$1 AND email=$4))",
    [organizationId, provider, email, tenant.email]
  );
  await pool.query(
    "INSERT INTO organization_storage_connections(organization_id,provider,workspace_reference,status,scopes,connected_by,connected_at,last_sync_status) VALUES($1,$2,$3,'connected',ARRAY[$4],(SELECT id FROM users WHERE organization_id=$1 AND email=$5),now(),'never')",
    [organizationId, organizationProvider, email, scope, tenant.email]
  );
}

async function seedOffer(tenant) {
  const org = await pool.query("SELECT id FROM organizations WHERE slug=$1", [tenant.slug]);
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const inserted = await pool.query(
    "INSERT INTO hotel_offers(organization_id,name,description,category,amount_minor,currency,status,availability_status,availability_verified_at,expires_at) VALUES($1,$2,$3,'spa',250000,'THB','active','available',now(),$4) RETURNING id",
    [org.rows[0].id, "Private spa offer " + tenant.name, "Only for " + tenant.name, expires]
  );
  tenant.offerId = inserted.rows[0].id;
}
async function seedOfferAttribution(tenant) {
  const inserted = await pool.query(
    "INSERT INTO hotel_offer_attributions(organization_id,offer_id,conversation_id,status) VALUES((SELECT id FROM organizations WHERE slug=$1),$2,$3,'enquiry') RETURNING id",
    [tenant.slug, tenant.offerId, tenant.conversationId]
  );
  tenant.attributionId = inserted.rows[0].id;
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
  const pmsTestResponse = await fetch(baseUrl + "/api/admin/integrations/pms/sandbox/test", {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/json", "X-CSRF-Token": tenants[0].csrfToken },
    body: "{}",
  });
  assert.equal(pmsTestResponse.status, 200, "tenant A owner can test the sandbox adapter");
  const pmsTestBody = await pmsTestResponse.json();
  assert.equal(pmsTestBody.mode, "sandbox");
  assert.equal(pmsTestBody.productionReady, false, "sandbox must never be represented as a production connection");
  const tenantBOrg = await pool.query("SELECT id FROM organizations WHERE slug=$1", [tenants[1].slug]);
  const tenantBUser = await pool.query("SELECT id FROM users WHERE organization_id=$1 AND email=$2", [tenantBOrg.rows[0].id, tenants[1].email]);
  await pool.query("INSERT INTO organization_pms_adapter_tests(organization_id,provider,mode,test_passed,tested_by) VALUES($1,'tenant-b-private-adapter','sandbox',true,$2)", [tenantBOrg.rows[0].id, tenantBUser.rows[0].id]);
  await pool.query("INSERT INTO pms_connections(organization_id,provider,mode,status,encrypted_credentials,scopes,connected_by,connected_at) VALUES($1,'tenant-b-private-adapter','sandbox','connected','test-ciphertext-not-a-secret',ARRAY['availability.read'],$2,now())", [tenantBOrg.rows[0].id, tenantBUser.rows[0].id]);
  const pmsAResponse = await fetch(baseUrl + "/api/admin/integrations/pms", { headers: { cookie: cookieA } });
  const pmsABody = await pmsAResponse.json();
  assert.equal(pmsAResponse.status, 200);
  assert.equal(pmsABody.tests.some(x => x.provider === "tenant-b-private-adapter"), false, "tenant A must not see tenant B PMS test records");
  assert.equal(pmsABody.connections.some(x => x.provider === "tenant-b-private-adapter"), false, "tenant A must not see tenant B PMS connection metadata");
  assert.equal(pmsABody.productionConnectionConfigured, false, "a sandbox connection must never be reported as production-ready");
  assert.equal(pmsABody.connections.some(x => Object.hasOwn(x, "encrypted_credentials")), false, "PMS credential ciphertext must never be exposed by the status API");
  const pmsBResponse = await fetch(baseUrl + "/api/admin/integrations/pms", { headers: { cookie: cookieB } });
  const pmsBBody = await pmsBResponse.json();
  assert.equal(pmsBResponse.status, 200);
  assert.equal(pmsBBody.tests.some(x => x.provider === "tenant-b-private-adapter"), true, "tenant B can see its own PMS test record");
  assert.equal(pmsBBody.connections.some(x => x.provider === "tenant-b-private-adapter"), true, "tenant B can see its own PMS connection metadata");
  const sandboxCredentialConnect = await fetch(baseUrl + "/api/admin/integrations/pms/sandbox/connect", {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/json", "X-CSRF-Token": tenants[0].csrfToken },
    body: JSON.stringify({ credentials: { clientSecret: "not-used" } }),
  });
  assert.equal(sandboxCredentialConnect.status, 409, "the framework sandbox must not accept production hotel credentials");
  const crossPmsDisconnect = await fetch(baseUrl + "/api/admin/integrations/pms/tenant-b-private-adapter", {
    method: "DELETE",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken },
  });
  assert.equal(crossPmsDisconnect.status, 200);
  assert.equal((await crossPmsDisconnect.json()).disconnected, false, "tenant A cannot disconnect tenant B's PMS connection");
  const pmsBAfterCrossDisconnect = await fetch(baseUrl + "/api/admin/integrations/pms", { headers: { cookie: cookieB } });
  const pmsBAfterCrossDisconnectBody = await pmsBAfterCrossDisconnect.json();
  assert.equal(pmsBAfterCrossDisconnectBody.connections.some(x => x.provider === "tenant-b-private-adapter"), true, "tenant B's PMS connection must remain intact after tenant A's disconnect attempt");
  await Promise.all(tenants.map(seedConversation));
  await Promise.all(tenants.map(seedKnowledge));
  await Promise.all(tenants.map(seedOffer));
  await Promise.all(tenants.map(seedOfferAttribution));
  await Promise.all([
    seedStorageConnection(tenants[0], "google"),
    seedStorageConnection(tenants[0], "microsoft"),
    seedStorageConnection(tenants[1], "google"),
  ]);


  const offersAResponse = await fetch(baseUrl + "/api/admin/offers", { headers: { cookie: cookieA } });
  assert.equal(offersAResponse.status, 200, "tenant A must read its own offers");
  const offersABody = await offersAResponse.json();
  assert.equal(offersABody.offers.length, 1);
  assert.equal(offersABody.offers[0].id, tenants[0].offerId);
  assert.equal(JSON.stringify(offersABody).includes(tenants[1].name), false, "tenant A must not see tenant B offer data");
  const offersBResponse = await fetch(baseUrl + "/api/admin/offers", { headers: { cookie: cookieB } });
  assert.equal(offersBResponse.status, 200, "tenant B must read its own offers");
  const offersBBody = await offersBResponse.json();
  assert.equal(offersBBody.offers.length, 1);
  assert.equal(offersBBody.offers[0].id, tenants[1].offerId);
  const unsupportedCurrencyOffer = await fetch(baseUrl + "/api/admin/offers", {
    method: "POST",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Synthetic invalid currency offer",
      description: "A test offer that must not accept an unknown currency code.",
      category: "spa",
      amount_minor: 100,
      currency: "ABC",
      status: "paused",
      verify_availability: false,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  });
  assert.equal(unsupportedCurrencyOffer.status, 400, "offer creation must reject unsupported ISO currency codes");
  const attributionAResponse = await fetch(baseUrl + "/api/admin/offer-attributions", { headers: { cookie: cookieA } });
  assert.equal(attributionAResponse.status, 200, "tenant A can view its revenue attribution");
  const attributionABody = await attributionAResponse.json();
  assert.equal(attributionABody.attributions.length, 1);
  assert.equal(attributionABody.attributions[0].id, tenants[0].attributionId);
  assert.equal(JSON.stringify(attributionABody).includes(tenants[1].name), false, "tenant A must not see tenant B attribution");
  const saleOccurredAt = new Date().toISOString();
  const validSaleEvidence = {
    status: "converted",
    amount_minor: 250000,
    currency: "THB",
    sale_occurred_at: saleOccurredAt,
    evidence_type: "pms_record",
    evidence_source_reference: "PMS-SALE-" + tag,
  };
  const crossAttributionUpdate = await fetch(baseUrl + "/api/admin/offer-attributions/" + tenants[1].attributionId, {
    method: "PATCH",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken, "content-type": "application/json" },
    body: JSON.stringify(validSaleEvidence),
  });
  assert.equal(crossAttributionUpdate.status, 404, "tenant A must not confirm tenant B's sale");
  const invalidConversion = await fetch(baseUrl + "/api/admin/offer-attributions/" + tenants[0].attributionId, {
    method: "PATCH",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken, "content-type": "application/json" },
    body: JSON.stringify({ ...validSaleEvidence, evidence_source_reference: "" }),
  });
  assert.equal(invalidConversion.status, 400, "a converted offer requires a traceable evidence reference");
  const saleBeforeEnquiry = await fetch(baseUrl + "/api/admin/offer-attributions/" + tenants[0].attributionId, {
    method: "PATCH",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken, "content-type": "application/json" },
    body: JSON.stringify({ ...validSaleEvidence, sale_occurred_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }),
  });
  assert.equal(saleBeforeEnquiry.status, 400, "a sale dated before the offer enquiry must not be attributed to it");
  const ownAttributionUpdate = await fetch(baseUrl + "/api/admin/offer-attributions/" + tenants[0].attributionId, {
    method: "PATCH",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken, "content-type": "application/json" },
    body: JSON.stringify({ ...validSaleEvidence, amount_minor: 235000, notes: "Checked against the hotel record" }),
  });
  assert.equal(ownAttributionUpdate.status, 200, "tenant A can confirm its own sale with evidence");
  const confirmedAttribution = await ownAttributionUpdate.json();
  assert.equal(confirmedAttribution.attribution.amount_minor, "235000");
  assert.equal(confirmedAttribution.attribution.status, "converted");
  assert.equal(confirmedAttribution.attribution.evidence_type, "pms_record");
  assert.equal(confirmedAttribution.attribution.evidence_source_reference, validSaleEvidence.evidence_source_reference);
  assert.ok(confirmedAttribution.attribution.sale_occurred_at);

  const attributionAAfter = await fetch(baseUrl + "/api/admin/offer-attributions", { headers: { cookie: cookieA } });
  const attributionAAfterBody = await attributionAAfter.json();
  assert.equal(attributionAAfterBody.windowDays, 30);
  assert.equal(Date.parse(attributionAAfterBody.windowEnd) - Date.parse(attributionAAfterBody.windowStart), 30 * 24 * 60 * 60 * 1000);
  assert.equal(attributionAAfterBody.enquiryCount, 1);
  assert.equal(attributionAAfterBody.distinctEnquiryConversationCount, 1);
  assert.equal(attributionAAfterBody.legacyUnreferencedConversionCount, 0);
  assert.equal(attributionAAfterBody.evidenceBackedTotals.length, 1);
  assert.equal(attributionAAfterBody.evidenceBackedTotals[0].amount_minor, "235000");
  assert.equal(attributionAAfterBody.evidenceBackedTotals[0].count, 1);
  const conversionAudit = await pool.query(
    "SELECT details FROM audit_logs WHERE organization_id=(SELECT id FROM organizations WHERE slug=$1) AND action='offer_attribution.converted' AND target_id=$2 ORDER BY created_at DESC LIMIT 1",
    [tenants[0].slug, tenants[0].attributionId]
  );
  assert.equal(conversionAudit.rows.length, 1, "the evidence update and its audit record must both persist");
  assert.equal(conversionAudit.rows[0].details.previous.status, "enquiry");
  assert.equal(conversionAudit.rows[0].details.current.evidence_source_reference, validSaleEvidence.evidence_source_reference);
  assert.equal(conversionAudit.rows[0].details.current.amount_minor, 235000);
  await assert.rejects(
    pool.query(
      "UPDATE hotel_offer_attributions SET evidence_source_reference='' WHERE id=$1 AND organization_id=(SELECT id FROM organizations WHERE slug=$2)",
      [tenants[0].attributionId, tenants[0].slug]
    ),
    /hotel_offer_attributions_converted_evidence_check/,
    "the database must reject a converted row after its evidence reference is removed"
  );
  const protectedEvidence = await pool.query(
    "SELECT evidence_source_reference FROM hotel_offer_attributions WHERE id=$1 AND organization_id=(SELECT id FROM organizations WHERE slug=$2)",
    [tenants[0].attributionId, tenants[0].slug]
  );
  assert.equal(protectedEvidence.rows[0].evidence_source_reference, validSaleEvidence.evidence_source_reference);

  const attributionBAfter = await fetch(baseUrl + "/api/admin/offer-attributions", { headers: { cookie: cookieB } });
  const attributionBBody = await attributionBAfter.json();
  assert.equal(attributionBBody.attributions[0].status, "enquiry", "tenant A's confirmation must not affect tenant B");
  assert.equal(attributionBBody.evidenceBackedTotals.length, 0, "tenant B must not see tenant A's evidence-backed value");
  assert.equal(attributionBBody.distinctEnquiryConversationCount, 1);
  assert.equal(JSON.stringify(attributionBBody).includes(validSaleEvidence.evidence_source_reference), false, "tenant B must not see tenant A's evidence reference");

  const crossOfferVerify = await fetch(baseUrl + "/api/admin/offers/" + tenants[1].offerId + "/verify", {
    method: "POST",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(crossOfferVerify.status, 404, "tenant A must not refresh availability for tenant B's offer");
  const ownOfferVerify = await fetch(baseUrl + "/api/admin/offers/" + tenants[0].offerId + "/verify", {
    method: "POST",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(ownOfferVerify.status, 200, "tenant A must be able to refresh availability for its own active offer");
  const crossOfferEdit = await fetch(baseUrl + "/api/admin/offers/" + tenants[1].offerId, {
    method: "PATCH",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken, "content-type": "application/json" },
    body: JSON.stringify({ name: "Unauthorised edit", description: "Attempt to edit another hotel's offer", category: "spa", amount_minor: 1, currency: "THB", status: "paused", verify_availability: false, expires_at: new Date(Date.now() + 3600000).toISOString() }),
  });
  assert.equal(crossOfferEdit.status, 404, "tenant A must not edit tenant B's offer");
  const crossOfferDelete = await fetch(baseUrl + "/api/admin/offers/" + tenants[1].offerId, {
    method: "DELETE",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken },
  });
  assert.equal(crossOfferDelete.status, 404, "tenant A must not delete tenant B's offer");
  const ownOfferDelete = await fetch(baseUrl + "/api/admin/offers/" + tenants[0].offerId, {
    method: "DELETE",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken },
  });
  assert.equal(ownOfferDelete.status, 200, "tenant A must be able to archive its own offer");
  const offerAArchived = await pool.query("SELECT id,status FROM hotel_offers WHERE id=$1 AND organization_id=(SELECT id FROM organizations WHERE slug=$2)", [tenants[0].offerId, tenants[0].slug]);
  const offerBPreserved = await pool.query("SELECT id,status FROM hotel_offers WHERE id=$1 AND organization_id=(SELECT id FROM organizations WHERE slug=$2)", [tenants[1].offerId, tenants[1].slug]);
  assert.equal(offerAArchived.rowCount, 1, "tenant A's offer history must be preserved");
  assert.equal(offerAArchived.rows[0].status, "paused", "archived offer must no longer be active");
  assert.equal(offerBPreserved.rowCount, 1, "tenant A archive must not affect tenant B's offer");
  const preservedAttribution = await pool.query("SELECT status,amount_minor FROM hotel_offer_attributions WHERE id=$1", [tenants[0].attributionId]);
  assert.equal(preservedAttribution.rowCount, 1, "archiving an offer must preserve its revenue attribution");
  assert.equal(preservedAttribution.rows[0].status, "converted", "historical confirmed sale must remain intact");

  const storageA = await readStorageConnections(cookieA);
  assert.equal(storageA.status, 200);
  const storageABody = await storageA.json();
  assert.deepEqual(storageABody.connections.map(connection => connection.provider), ["google", "microsoft"]);
  assert.equal(storageABody.connections[0].account_email, "storage-google-" + tenants[0].email);
  assert.equal(storageABody.connections[1].account_email, "storage-microsoft-" + tenants[0].email);
  assert.equal(Object.hasOwn(storageABody.connections[0], "encrypted_tokens"), false, "storage tokens must never be returned by the dashboard API");
  assert.equal(JSON.stringify(storageABody).includes("test-encrypted-token"), false, "storage token ciphertext must never be exposed");
  assert.equal(JSON.stringify(storageABody).includes(tenants[1].email), false, "tenant A must not see tenant B's storage account");
  const storageB = await readStorageConnections(cookieB);
  assert.equal(storageB.status, 200);
  const storageBBody = await storageB.json();
  assert.deepEqual(storageBBody.connections.map(connection => connection.provider), ["google"]);
  assert.equal(storageBBody.connections[0].account_email, "storage-google-" + tenants[1].email);
  assert.equal(JSON.stringify(storageBBody).includes(tenants[0].email), false, "tenant B must not see tenant A's storage account");

  const crossDisconnect = await fetch(baseUrl + "/api/admin/storage/connections/google", {
    method: "DELETE",
    headers: { cookie: cookieA, "X-CSRF-Token": tenants[0].csrfToken },
  });
  assert.equal(crossDisconnect.status, 200, "disconnecting an unowned provider should safely report no local connection");
  const storageBAfter = await readStorageConnections(cookieB);
  assert.equal(storageBAfter.status, 200);
  const storageBAfterBody = await storageBAfter.json();
  assert.equal(storageBAfterBody.connections[0].account_email, "storage-google-" + tenants[1].email, "tenant A must not disconnect tenant B's storage connection");
  const storageAAfter = await readStorageConnections(cookieA);
  const storageAAfterBody = await storageAAfter.json();
  assert.deepEqual(storageAAfterBody.connections.map(connection => connection.provider), ["microsoft"], "disconnecting Google must preserve the same hotel's Microsoft connection");

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
  const webhookReceivedAt = new Date();
  const webhookEvent = {
    eventId: "tenant-isolation-event-" + tag,
    eventType: "reservation.confirmed",
    occurredAt: new Date(webhookReceivedAt.getTime() - 60_000).toISOString(),
    data: { reservationReference: "synthetic-" + tag },
  };
  const webhookAFirst = await recordWebhookEvent(pool, orgA, "test-provider", webhookEvent, webhookReceivedAt);
  const webhookADuplicate = await recordWebhookEvent(pool, orgA, "test-provider", webhookEvent, webhookReceivedAt);
  const webhookBFirst = await recordWebhookEvent(pool, orgB, "test-provider", webhookEvent, webhookReceivedAt);
  assert.equal(webhookAFirst.accepted, true, "tenant A's first provider event must be accepted");
  assert.equal(webhookADuplicate.duplicate, true, "repeated provider event must be idempotently rejected for tenant A");
  assert.equal(webhookBFirst.accepted, true, "the same provider event ID is independent in tenant B");
  const webhookRows = await pool.query(
    "SELECT organization_id,provider,external_event_id,payload_sha256 FROM pms_webhook_events WHERE external_event_id=$1 ORDER BY organization_id",
    [webhookEvent.eventId],
  );
  assert.equal(webhookRows.rowCount, 2, "the event inbox must keep one record per tenant, not one global record");
  assert.notEqual(webhookRows.rows[0].organization_id, webhookRows.rows[1].organization_id);
  assert.equal(webhookRows.rows.every(row => /^[a-f0-9]{64}$/.test(row.payload_sha256)), true);
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
  console.log("PASS: tenant-scoped transcripts, knowledge, storage connections, revenue offers and sale attribution verified for two hotel workspaces.");
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
