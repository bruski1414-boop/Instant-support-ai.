const { createTokenCipher, readTextLimited, fetchMicrosoftDownload } = require("./storage-security");

const PROVIDERS = {
  google: {
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/drive.readonly",
  },
  microsoft: {
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access User.Read Files.Read.All Sites.Read.All",
  },
};

function parseSourceReference(value) {
  if (typeof value !== "string" || value.length > 1200) throw new Error("Invalid hotel knowledge source reference.");
  const separator = value.indexOf(":");
  if (separator < 1) throw new Error("Invalid hotel knowledge source reference.");
  const provider = value.slice(0, separator);
  const reference = value.slice(separator + 1);
  if (provider === "google") {
    if (!reference || reference.length > 500) throw new Error("Invalid Google Drive source reference.");
    return { provider, fileId: reference, siteId: "" };
  }
  if (provider === "microsoft") {
    // Legacy imports used a plain item ID and therefore refer to the connected user's OneDrive.
    if (reference && !reference.startsWith("v1.")) {
      if (reference.length > 500) throw new Error("Invalid Microsoft source reference.");
      return { provider, fileId: reference, siteId: "" };
    }
    if (!reference.startsWith("v1.")) throw new Error("Invalid Microsoft source reference.");
    let parsed;
    try { parsed = JSON.parse(Buffer.from(reference.slice(3), "base64url").toString("utf8")); }
    catch { throw new Error("Invalid Microsoft source reference."); }
    if (!parsed || typeof parsed.fileId !== "string" || !parsed.fileId || parsed.fileId.length > 500 ||
        typeof parsed.siteId !== "string" || parsed.siteId.length > 300) {
      throw new Error("Invalid Microsoft source reference.");
    }
    return { provider, fileId: parsed.fileId, siteId: parsed.siteId };
  }
  throw new Error("Unsupported hotel knowledge source provider.");
}

function encodeMicrosoftSourceReference(fileId, siteId = "") {
  if (typeof fileId !== "string" || !fileId || fileId.length > 500 ||
      typeof siteId !== "string" || siteId.length > 300) throw new Error("Invalid Microsoft source details.");
  return "microsoft:v1." + Buffer.from(JSON.stringify({ fileId, siteId }), "utf8").toString("base64url");
}

function createStorageKnowledgeReader({ db, fetchImpl = globalThis.fetch, encryptionKey = process.env.STORAGE_TOKEN_ENCRYPTION_KEY || "" }) {
  if (!db || typeof db.query !== "function") throw new Error("A database client is required.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const cipher = createTokenCipher(encryptionKey);
  const decrypt = cipher.decrypt;
  const encrypt = cipher.encrypt;

  const refreshes = new Map();

  async function accessToken(organizationId, provider) {
    const stored = await db.query(
      "SELECT encrypted_tokens FROM storage_connections WHERE organization_id=$1 AND provider=$2 AND status='connected'",
      [organizationId, provider]
    );
    if (!stored.rowCount) throw new Error("The hotel's connected storage source is unavailable.");
    const tokens = decrypt(stored.rows[0].encrypted_tokens);
    if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("Storage authorization must be renewed.");
    if (Number(tokens.expires_at) > Date.now() + 60000) return tokens.access_token;

    const refreshKey = organizationId + ":" + provider;
    const pending = refreshes.get(refreshKey);
    if (pending) return pending;

    const refreshPromise = (async () => {
      if (!tokens.refresh_token) throw new Error("Storage authorization must be renewed.");
      const clientId = provider === "google" ? process.env.GOOGLE_OAUTH_CLIENT_ID : process.env.MICROSOFT_OAUTH_CLIENT_ID;
      const clientSecret = provider === "google" ? process.env.GOOGLE_OAUTH_CLIENT_SECRET : process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
      if (!clientId || !clientSecret) throw new Error("Storage authorization must be renewed.");
      const form = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: "refresh_token",
      });
      if (provider === "microsoft") form.set("scope", PROVIDERS.microsoft.scope);
      const response = await fetchImpl(PROVIDERS[provider].token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(12000),
      });
      const next = await response.json().catch(() => ({}));
      if (!response.ok || typeof next.access_token !== "string" || !next.access_token) {
        throw new Error("Storage authorization must be renewed.");
      }
      const merged = {
        ...tokens,
        access_token: next.access_token,
        refresh_token: next.refresh_token || tokens.refresh_token,
        expires_at: Date.now() + Number(next.expires_in || 3600) * 1000,
      };
      await db.query(
        "UPDATE storage_connections SET encrypted_tokens=$1 WHERE organization_id=$2 AND provider=$3 AND status='connected'",
        [encrypt(merged), organizationId, provider]
      );
      return merged.access_token;
    })();

    refreshes.set(refreshKey, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      if (refreshes.get(refreshKey) === refreshPromise) refreshes.delete(refreshKey);
    }
  }

  async function read({ organizationId, sourceReference }) {
    if (typeof organizationId !== "string" || !organizationId) throw new Error("Hotel context is required.");
    const source = parseSourceReference(sourceReference);
    const token = await accessToken(organizationId, source.provider);
    const headers = { authorization: "Bearer " + token };
    let metadata;
    let contentResponse;

    if (source.provider === "google") {
      const metaUrl = new URL("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(source.fileId));
      metaUrl.searchParams.set("fields", "id,name,mimeType,modifiedTime,md5Checksum,webViewLink");
      const metaResponse = await fetchImpl(metaUrl, { headers, signal: AbortSignal.timeout(12000) });
      metadata = await metaResponse.json().catch(() => ({}));
      if (!metaResponse.ok || metadata.id !== source.fileId ||
          !["text/plain", "application/vnd.google-apps.document"].includes(metadata.mimeType)) {
        throw new Error("The linked Google document is unavailable or no longer an approved file type.");
      }
      const exportMode = metadata.mimeType === "application/vnd.google-apps.document";
      const contentUrl = exportMode
        ? "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(source.fileId) + "/export?mimeType=text/plain"
        : "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(source.fileId) + "?alt=media";
      contentResponse = await fetchImpl(contentUrl, { headers, signal: AbortSignal.timeout(20000) });
    } else {
      const driveBase = source.siteId
        ? "https://graph.microsoft.com/v1.0/sites/" + encodeURIComponent(source.siteId) + "/drive"
        : "https://graph.microsoft.com/v1.0/me/drive";
      const metaUrl = driveBase + "/items/" + encodeURIComponent(source.fileId) + "?$select=id,name,file,webUrl,lastModifiedDateTime,eTag";
      const metaResponse = await fetchImpl(metaUrl, { headers, signal: AbortSignal.timeout(12000) });
      metadata = await metaResponse.json().catch(() => ({}));
      if (!metaResponse.ok || metadata.id !== source.fileId || metadata.file?.mimeType !== "text/plain") {
        throw new Error("The linked Microsoft document is unavailable or no longer an approved file type.");
      }
      const response = await fetchImpl(driveBase + "/items/" + encodeURIComponent(source.fileId) + "/content", {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
      if (response.status === 200) contentResponse = response;
      else if ([302, 303].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Microsoft storage returned an invalid download redirect.");
        contentResponse = await fetchMicrosoftDownload(location, { signal: AbortSignal.timeout(20000) }, fetchImpl);
      } else throw new Error("The linked Microsoft document could not be downloaded.");
    }

    const content = await readTextLimited(contentResponse);
    if (!content.trim()) throw new Error("The linked hotel document is empty.");
    return {
      provider: source.provider,
      sourceId: source.fileId,
      title: String(metadata.name || "Hotel document").slice(0, 160),
      content: content.trim(),
      modifiedAt: metadata.modifiedTime || metadata.lastModifiedDateTime || null,
      version: metadata.modifiedTime || metadata.md5Checksum || metadata.eTag || metadata.lastModifiedDateTime || null,
      webUrl: typeof metadata.webViewLink === "string" ? metadata.webViewLink : (typeof metadata.webUrl === "string" ? metadata.webUrl : ""),
    };
  }

  return { read };
}

module.exports = { createStorageKnowledgeReader, parseSourceReference, encodeMicrosoftSourceReference };
