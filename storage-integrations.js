const express = require("express");
const crypto = require("node:crypto");

const PROVIDERS = {
  google: {
    label: "Google Drive",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/drive.readonly",
  },
  microsoft: {
    label: "Microsoft OneDrive / SharePoint",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access User.Read Files.Read.All Sites.Read.All",
  },
};

function createStorageRouter({ db, auth, role, audit }) {
  const router = express.Router();
  const redirectBase = (process.env.STORAGE_OAUTH_REDIRECT_BASE || "").replace(/\/+$/, "");
  const keyText = process.env.STORAGE_TOKEN_ENCRYPTION_KEY || "";
  let key = null;
  try {
    const decoded = Buffer.from(keyText, "base64");
    if (decoded.length === 32) key = decoded;
  } catch {}

  const encrypt = (value) => {
    if (!key) throw new Error("STORAGE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  };
  const decrypt = (value) => {
    if (!key) throw new Error("Storage encryption key is unavailable.");
    const [iv, tag, body] = String(value).split(".");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"));
  };
  const safeError = (res, error, status = 400) => res.status(status).json({ error });
  const providerValid = (p) => Object.prototype.hasOwnProperty.call(PROVIDERS, p);
  const callbackUrl = () => redirectBase + "/api/admin/storage/oauth/callback";

  router.get("/connections", auth, async (req, res) => {
    try {
      const result = await db.query(
        "SELECT provider,account_email,connected_at,last_sync_at,status FROM storage_connections WHERE organization_id=$1 ORDER BY provider",
        [req.actor.organization_id]
      );
      res.json({
        connections: result.rows,
        configured: {
          google: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET),
          microsoft: Boolean(process.env.MICROSOFT_OAUTH_CLIENT_ID && process.env.MICROSOFT_OAUTH_CLIENT_SECRET),
          encryption: Boolean(key),
          redirect: Boolean(redirectBase),
        },
      });
    } catch (e) { res.status(500).json({ error: "Could not load storage connections." }); }
  });

  router.post("/connect/:provider", auth, role("owner", "admin"), async (req, res) => {
    const provider = req.params.provider;
    if (!providerValid(provider)) return safeError(res, "Unsupported storage provider.");
    if (!redirectBase || !key) return safeError(res, "Storage OAuth is not configured by the platform administrator.", 503);
    const clientId = provider === "google" ? process.env.GOOGLE_OAUTH_CLIENT_ID : process.env.MICROSOFT_OAUTH_CLIENT_ID;
    const clientSecret = provider === "google" ? process.env.GOOGLE_OAUTH_CLIENT_SECRET : process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return safeError(res, "This storage provider has not been configured yet.", 503);

    try {
      const state = crypto.randomBytes(32).toString("base64url");
      await db.query(
        "INSERT INTO storage_oauth_states(state_hash,organization_id,user_id,provider,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
        [crypto.createHash("sha256").update(state).digest("hex"), req.actor.organization_id, req.actor.user_id, provider]
      );
      const config = PROVIDERS[provider];
      const url = new URL(config.authorize);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", callbackUrl());
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", config.scope);
      url.searchParams.set("state", state);
      url.searchParams.set("prompt", "consent");
      if (provider === "google") url.searchParams.set("access_type", "offline");
      res.json({ authorizationUrl: url.toString() });
    } catch (e) { res.status(500).json({ error: "Could not start the secure connection." }); }
  });

  router.get("/oauth/callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (error || typeof code !== "string" || typeof state !== "string") return res.redirect("/dashboard.html?storage=cancelled");
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        "DELETE FROM storage_oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING organization_id,user_id,provider",
        [stateHash]
      );
      if (!found.rowCount) { await client.query("ROLLBACK"); return res.redirect("/dashboard.html?storage=invalid"); }
      const context = found.rows[0];
      const provider = context.provider;
      const clientId = provider === "google" ? process.env.GOOGLE_OAUTH_CLIENT_ID : process.env.MICROSOFT_OAUTH_CLIENT_ID;
      const clientSecret = provider === "google" ? process.env.GOOGLE_OAUTH_CLIENT_SECRET : process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
      const form = new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, code,
        redirect_uri: callbackUrl(), grant_type: "authorization_code",
      });
      if (provider === "microsoft") form.set("scope", PROVIDERS.microsoft.scope);
      const tokenResponse = await fetch(PROVIDERS[provider].token, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
        signal: AbortSignal.timeout(12000),
      });
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok || !tokens.access_token) throw new Error("Token exchange failed.");
      let accountEmail = "";
      if (provider === "google") {
        const profile = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { authorization: "Bearer " + tokens.access_token }, signal: AbortSignal.timeout(10000) });
        if (profile.ok) accountEmail = (await profile.json()).email || "";
      } else {
        const profile = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { authorization: "Bearer " + tokens.access_token }, signal: AbortSignal.timeout(10000) });
        if (profile.ok) { const p = await profile.json(); accountEmail = p.mail || p.userPrincipalName || ""; }
      }
      const encrypted = encrypt({ access_token: tokens.access_token, refresh_token: tokens.refresh_token || null, expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000, scope: tokens.scope || "" });
      await client.query(
        "INSERT INTO storage_connections(organization_id,provider,account_email,encrypted_tokens,status,connected_by,connected_at) VALUES($1,$2,$3,$4,'connected',$5,now()) ON CONFLICT(organization_id,provider) DO UPDATE SET account_email=EXCLUDED.account_email,encrypted_tokens=EXCLUDED.encrypted_tokens,status='connected',connected_by=EXCLUDED.connected_by,connected_at=now(),last_error=NULL",
        [context.organization_id, provider, accountEmail.slice(0,254), encrypted, context.user_id]
      );
      await client.query("INSERT INTO audit_logs(organization_id,actor_user_id,action,target_type) VALUES($1,$2,$3,'storage_connection')", [context.organization_id, context.user_id, "storage." + provider + ".connected"]);
      await client.query("COMMIT");
      res.redirect("/dashboard.html?storage=connected");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Storage OAuth callback failed:", e.message);
      res.redirect("/dashboard.html?storage=failed");
    } finally { client.release(); }
  });

  async function accessToken(organizationId, provider) {
    const result = await db.query("SELECT encrypted_tokens FROM storage_connections WHERE organization_id=$1 AND provider=$2 AND status='connected'", [organizationId, provider]);
    if (!result.rowCount) throw new Error("Connect this storage account first.");
    const tokens = decrypt(result.rows[0].encrypted_tokens);
    if (tokens.expires_at > Date.now() + 60000) return tokens.access_token;
    if (!tokens.refresh_token) throw new Error("Storage authorization expired. Reconnect the account.");
    const clientId = provider === "google" ? process.env.GOOGLE_OAUTH_CLIENT_ID : process.env.MICROSOFT_OAUTH_CLIENT_ID;
    const clientSecret = provider === "google" ? process.env.GOOGLE_OAUTH_CLIENT_SECRET : process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
    const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: tokens.refresh_token, grant_type: "refresh_token" });
    if (provider === "microsoft") form.set("scope", PROVIDERS.microsoft.scope);
    const response = await fetch(PROVIDERS[provider].token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(12000) });
    const next = await response.json();
    if (!response.ok || !next.access_token) throw new Error("Storage authorization expired. Reconnect the account.");
    const merged = { ...tokens, access_token: next.access_token, refresh_token: next.refresh_token || tokens.refresh_token, expires_at: Date.now() + Number(next.expires_in || 3600) * 1000 };
    await db.query("UPDATE storage_connections SET encrypted_tokens=$1 WHERE organization_id=$2 AND provider=$3", [encrypt(merged), organizationId, provider]);
    return merged.access_token;
  }

  router.get("/sites/microsoft", auth, async (req, res) => {
    try {
      const token = await accessToken(req.actor.organization_id, "microsoft");
      const response = await fetch("https://graph.microsoft.com/v1.0/sites?search=*&$select=id,name,webUrl&$top=100", { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok) throw new Error("Could not list SharePoint sites.");
      res.json({ sites: (body.value || []).map(site => ({ id: site.id, name: site.name, webUrl: site.webUrl || "" })) });
    } catch (e) { res.status(502).json({ error: e.message || "Could not list SharePoint sites." }); }
  });

  router.get("/files/:provider", auth, async (req, res) => {
    const provider = req.params.provider;
    if (!providerValid(provider)) return safeError(res, "Unsupported storage provider.");
    try {
      const token = await accessToken(req.actor.organization_id, provider);
      let files;
      if (provider === "google") {
        const url = new URL("https://www.googleapis.com/drive/v3/files");
        url.searchParams.set("pageSize", "100");
        url.searchParams.set("orderBy", "modifiedTime desc");
        url.searchParams.set("q", "trashed=false and (mimeType='text/plain' or mimeType='application/vnd.google-apps.document')");
        url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken");
        const response = await fetch(url, { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(15000) });
        const body = await response.json();
        if (!response.ok) throw new Error("Google Drive could not list files.");
        files = (body.files || []).map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, webUrl: f.webViewLink || "" }));
      } else {
        const siteId = typeof req.query.siteId === "string" ? req.query.siteId.slice(0, 300) : "";
        const endpoint = siteId
          ? "https://graph.microsoft.com/v1.0/sites/" + encodeURIComponent(siteId) + "/drive/root/children?$top=100&$select=id,name,file,lastModifiedDateTime,webUrl"
          : "https://graph.microsoft.com/v1.0/me/drive/root/children?$top=100&$select=id,name,file,lastModifiedDateTime,webUrl";
        const response = await fetch(endpoint, { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(15000) });
        const body = await response.json();
        if (!response.ok) throw new Error("Microsoft storage could not list files.");
        files = (body.value || []).filter(f => f.file && f.file.mimeType === "text/plain").map(f => ({ id: f.id, name: f.name, mimeType: f.file.mimeType, modifiedTime: f.lastModifiedDateTime, webUrl: f.webUrl || "", siteId }));
      }
      await db.query("UPDATE storage_connections SET last_sync_at=now(),last_error=NULL WHERE organization_id=$1 AND provider=$2", [req.actor.organization_id, provider]);
      res.json({ provider, files });
    } catch (e) {
      await db.query("UPDATE storage_connections SET last_error=$1 WHERE organization_id=$2 AND provider=$3", [String(e.message).slice(0,300), req.actor.organization_id, provider]).catch(() => {});
      res.status(502).json({ error: e.message || "Could not list storage files." });
    }
  });

  router.post("/import/:provider", auth, role("owner", "admin"), async (req, res) => {
    const provider = req.params.provider;
    const fileId = req.body?.fileId;
    const siteId = typeof req.body?.siteId === "string" ? req.body.siteId.slice(0, 300) : "";
    if (!providerValid(provider) || typeof fileId !== "string" || !fileId || fileId.length > 500) return safeError(res, "Choose a valid file.");
    try {
      const token = await accessToken(req.actor.organization_id, provider);
      let name, content = "";
      if (provider === "google") {
        const metaResponse = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?fields=id,name,mimeType,webViewLink", { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(12000) });
        const meta = await metaResponse.json();
        if (!metaResponse.ok || !["text/plain", "application/vnd.google-apps.document"].includes(meta.mimeType)) return safeError(res, "Only plain-text files and Google Docs can be imported.");
        name = meta.name;
        const exportMode = meta.mimeType === "application/vnd.google-apps.document";
        const url = exportMode ? "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "/export?mimeType=text/plain" : "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media";
        const response = await fetch(url, { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error("Could not download the selected Google document.");
        content = await response.text();
      } else {
        const driveBase = siteId ? "https://graph.microsoft.com/v1.0/sites/" + encodeURIComponent(siteId) + "/drive" : "https://graph.microsoft.com/v1.0/me/drive";
        const metaResponse = await fetch(driveBase + "/items/" + encodeURIComponent(fileId) + "?$select=id,name,file,webUrl", { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(12000) });
        const meta = await metaResponse.json();
        if (!metaResponse.ok || meta.file?.mimeType !== "text/plain") return safeError(res, "Only plain-text files can be imported from Microsoft storage in this release.");
        name = meta.name;
        const response = await fetch(driveBase + "/items/" + encodeURIComponent(fileId) + "/content", { headers: { authorization: "Bearer " + token }, redirect: "manual", signal: AbortSignal.timeout(20000) });
        if (![200, 302, 303].includes(response.status)) throw new Error("Could not download the selected Microsoft document.");
        const downloadUrl = response.status === 200 ? null : response.headers.get("location");
        const contentResponse = response.status === 200 ? response : await fetch(downloadUrl, { signal: AbortSignal.timeout(20000) });
        content = await contentResponse.text();
      }
      if (!content.trim() || Buffer.byteLength(content, "utf8") > 12000) return safeError(res, "The selected file is empty or larger than the 12 KB knowledge-document limit.");
      name = String(name || "Imported hotel document").slice(0, 160);
      const source = provider + ":" + fileId;
      const existing = await db.query("SELECT * FROM knowledge_documents WHERE organization_id=$1 AND source_reference=$2", [req.actor.organization_id, source]);
      let document;
      if (existing.rowCount) {
        const previous = existing.rows[0];
        await db.query("INSERT INTO knowledge_document_versions(organization_id,document_id,title,category,content,approved,source_reference,review_due_at,reviewed_at,changed_by,change_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'storage_refresh')", [req.actor.organization_id, previous.id, previous.title, previous.category, previous.content, previous.approved, previous.source_reference, previous.review_due_at, previous.reviewed_at, req.actor.user_id]);
        const updated = await db.query("UPDATE knowledge_documents SET title=$1,content=$2,approved=false,reviewed_at=NULL,updated_by=$3,updated_at=now() WHERE id=$4 AND organization_id=$5 RETURNING id,title,approved,source_reference,updated_at", [name, content.trim(), req.actor.user_id, previous.id, req.actor.organization_id]);
        document = updated.rows[0];
      } else {
        const inserted = await db.query("INSERT INTO knowledge_documents(organization_id,title,category,content,approved,source_reference,updated_by) VALUES($1,$2,'imported_document',$3,false,$4,$5) RETURNING id,title,approved,source_reference,updated_at", [req.actor.organization_id, name, content.trim(), source, req.actor.user_id]);
        document = inserted.rows[0];
      }
      await db.query("INSERT INTO knowledge_document_versions(organization_id,document_id,title,category,content,approved,source_reference,changed_by,change_type) VALUES($1,$2,$3,'imported_document',$4,false,$5,$6,'storage_imported')", [req.actor.organization_id, document.id, document.title, content.trim(), source, req.actor.user_id]);
      await audit(req.actor, "storage." + provider + ".file_imported", "knowledge_document", document.id);
      res.status(201).json({ document, approvalRequired: true, message: "Imported as unapproved hotel knowledge. A hotel manager must verify it before Veyra can use it." });
    } catch (e) { res.status(502).json({ error: e.message || "Import failed." }); }
  });

  router.delete("/connections/:provider", auth, role("owner", "admin"), async (req, res) => {
    const provider = req.params.provider;
    if (!providerValid(provider)) return safeError(res, "Unsupported storage provider.");
    try {
      const result = await db.query("DELETE FROM storage_connections WHERE organization_id=$1 AND provider=$2 RETURNING provider", [req.actor.organization_id, provider]);
      await db.query("DELETE FROM storage_oauth_states WHERE organization_id=$1 AND provider=$2", [req.actor.organization_id, provider]);
      await audit(req.actor, "storage." + provider + ".disconnected", "storage_connection");
      res.json({ disconnected: Boolean(result.rowCount) });
    } catch (e) { res.status(500).json({ error: "Could not disconnect storage." }); }
  });

  return router;
}

module.exports = { createStorageRouter };
