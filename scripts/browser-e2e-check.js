const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..");
const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let browser;

async function startStaticServer() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    const files = {
      "/guest.html": ["guest.html", "text/html; charset=utf-8"],
      "/dashboard.html": ["dashboard.html", "text/html; charset=utf-8"],
      "/widget.js": ["widget.js", "application/javascript; charset=utf-8"],
      "/widget.css": ["widget.css", "text/css; charset=utf-8"],
    };
    const entry = files[pathname];
    if (!entry) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": entry[1], "Cache-Control": "no-store" });
    res.end(fs.readFileSync(path.join(root, entry[0])));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: "http://127.0.0.1:" + server.address().port };
}

test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

test("guest chat sends a message, disables duplicate submission, and stores the conversation", async (t) => {
  const host = await startStaticServer();
  t.after(() => new Promise(resolve => host.server.close(resolve)));
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  let requestCount = 0;
  await page.route("**/api/public/**/chat", async route => {
    requestCount++;
    await new Promise(resolve => setTimeout(resolve, 120));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      reply: "Breakfast is served from 7:00 AM to 10:30 AM.",
      conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      needsHuman: false,
    }) });
  });
  await page.goto(host.origin + "/guest.html?workspace=" + workspace);
  const input = page.locator("#message");
  const send = page.locator("#send");
  await input.fill("When is breakfast?");
  await send.click();
  await page.getByText("Sending…").waitFor();
  await assert.equal(await input.isDisabled(), true);
  await assert.equal(await send.isDisabled(), true);
  await page.getByText("Breakfast is served from 7:00 AM to 10:30 AM.").waitFor();
  await assert.equal(await input.inputValue(), "");
  await assert.equal(requestCount, 1);
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), "veyra-conversation-" + workspace), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  await assert.equal(await page.locator("#composerHint").textContent(), "Your message was sent. You can ask another question below.");
});

test("guest chat preserves the draft and explains that delivery was not confirmed on API failure", async (t) => {
  const host = await startStaticServer();
  t.after(() => new Promise(resolve => host.server.close(resolve)));
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route("**/api/public/**/chat", route => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "Support is temporarily unavailable." }),
  }));
  await page.goto(host.origin + "/guest.html?workspace=" + workspace);
  await page.locator("#message").fill("Can I check in early?");
  await page.locator("#send").click();
  await page.getByText("Support is temporarily unavailable.").waitFor();
  assert.equal(await page.locator("#message").inputValue(), "Can I check in early?");
  assert.match(await page.locator("#composerHint").textContent(), /not confirmed/);
  assert.equal(await page.locator("#send").isDisabled(), false);
});

test("guest chat remains usable when session storage is blocked", async (t) => {
  const host = await startStaticServer();
  t.after(() => new Promise(resolve => host.server.close(resolve)));
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => Object.defineProperty(window, "sessionStorage", {
    configurable: true, get() { throw new Error("Storage blocked by browser policy"); },
  }));
  await page.route("**/api/public/**/chat", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({
      reply: "Reception can confirm early check-in.",
      conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      needsHuman: true, notificationStatus: "not-configured",
    }),
  }));
  await page.goto(host.origin + "/guest.html?workspace=" + workspace);
  await page.locator("#message").fill("Can I check in early?");
  await page.locator("#send").click();
  await page.getByText("Reception can confirm early check-in.").waitFor();
  await page.getByText(/automatic staff alert was not confirmed/i).waitFor();
  assert.equal(await page.locator("#send").isDisabled(), false);
});

test("invalid workspace hides the guest composer", async (t) => {
  const host = await startStaticServer();
  t.after(() => new Promise(resolve => host.server.close(resolve)));
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(host.origin + "/guest.html?workspace=not-a-uuid");
  await page.getByText(/support link is invalid/i).waitFor();
  assert.equal(await page.locator("#form").isHidden(), true);
});

test("website launcher renders once and points to the correct hosted guest chat", async (t) => {
  const host = await startStaticServer();
  t.after(() => new Promise(resolve => host.server.close(resolve)));
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(host.origin + "/guest.html");
  await page.evaluate(({ origin, workspace }) => {
    const first = document.createElement("script");
    first.src = origin + "/widget.js?workspace=" + workspace;
    first.dataset.workspace = workspace;
    document.body.append(first);
    const second = document.createElement("script");
    second.src = origin + "/widget.js?workspace=" + workspace;
    second.dataset.workspace = workspace;
    document.body.append(second);
  }, { origin: host.origin, workspace });
  const launcher = page.locator("[data-veyra-widget='true']");
  await launcher.waitFor();
  assert.equal(await launcher.count(), 1);
  assert.equal(await launcher.getAttribute("href"), host.origin + "/guest.html?workspace=" + workspace);
  assert.equal(await launcher.getAttribute("rel"), "noopener noreferrer");
});

test("authenticated dashboard loads and saves knowledge, privacy, and website settings", async (t) => {
  const host = await startStaticServer();
  t.after(() => new Promise(resolve => host.server.close(resolve)));
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addCookies([{ name: "veyra_csrf", value: "csrf-test-token", url: host.origin }]);
  const page = await context.newPage();
  const documentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const state = { documents: [], retentionDays: 90, origins: [] };
  const writes = [];

  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const payload = request.postData() ? JSON.parse(request.postData()) : {};
    let status = 200;
    let body = {};

    if (method !== "GET") {
      const headers = request.headers();
      writes.push({ path: url.pathname, csrf: headers["x-csrf-token"], tenant: headers["x-veyra-workspace"] });
    }

    if (url.pathname === "/api/auth/me" && method === "GET") {
      body = { authenticated: true, user: { email: "owner@northstar.example" }, memberships: [{ tenant_id: workspace, role: "owner" }] };
    } else if (url.pathname === "/api/workspaces" && method === "GET") {
      body = { workspaces: [{ id: workspace, name: "Northstar Hotel Demo", role: "owner" }] };
    } else if (url.pathname === "/api/health" && method === "GET") {
      body = { status: "ready", liveAIReady: true, businessKnowledgeConfigured: true, handoffConfigured: false };
    } else if (url.pathname === "/api/knowledge" && method === "GET") {
      body = { documents: state.documents, role: "owner" };
    } else if (url.pathname === "/api/knowledge" && method === "POST") {
      const doc = { id: documentId, title: payload.title, content: payload.content, version: 1, approved_at: null };
      state.documents = [doc];
      status = 201;
      body = { document: doc };
    } else if (url.pathname === "/api/knowledge/" + documentId + "/approve" && method === "POST") {
      state.documents[0].approved_at = "2026-11-11T00:00:00.000Z";
      body = { document: state.documents[0] };
    } else if (url.pathname === "/api/conversations" && method === "GET") {
      body = { conversations: [] };
    } else if (url.pathname === "/api/handoffs" && method === "GET") {
      body = { handoffs: [], delivery: "dashboard-queue-only" };
    } else if (url.pathname === "/api/integrations/slack" && method === "GET") {
      body = { configured: false, encryptionReady: true };
    } else if (url.pathname === "/api/privacy/retention" && method === "GET") {
      body = { conversationRetentionDays: state.retentionDays, canManage: true };
    } else if (url.pathname === "/api/privacy/retention" && method === "PATCH") {
      state.retentionDays = payload.conversationRetentionDays;
      body = { conversationRetentionDays: state.retentionDays };
    } else if (url.pathname === "/api/widget/domains" && method === "GET") {
      body = { origins: state.origins, canManage: true };
    } else if (url.pathname === "/api/widget/domains" && method === "PUT") {
      state.origins = payload.origins;
      body = { saved: true, origins: state.origins };
    } else {
      status = 404;
      body = { error: "Unexpected test API request: " + method + " " + url.pathname };
    }

    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(host.origin + "/dashboard.html");
  await page.waitForFunction(() => document.getElementById("workspaceName")?.textContent === "Northstar Hotel Demo");
  assert.equal(await page.locator("#accountEmail").textContent(), "owner@northstar.example");
  await page.getByText("No knowledge documents yet.").waitFor();

  await page.locator("#knowledgeTitle").fill("Check-in policy");
  await page.locator("#knowledgeContent").fill("Check-in begins at 3:00 PM.");
  await page.locator("#knowledgeSave").click();
  await page.getByText("Draft · not used for answers").waitFor();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText("Approved", { exact: true }).waitFor();

  await page.locator("#retentionDays").selectOption("180");
  await page.locator("#saveRetention").click();
  await page.getByText("Saved. Conversations older than 180 days will be purged on the next workspace access.").waitFor();

  await page.locator("#widgetDomains").fill("https://www.northstar.example");
  await page.locator("#saveWidgetDomains").click();
  await page.getByText("1 approved domain saved. The launcher is blocked on all other websites.").waitFor();

  assert.equal(state.retentionDays, 180);
  assert.deepEqual(state.origins, ["https://www.northstar.example"]);
  assert.equal(writes.length, 4);
  for (const write of writes) {
    assert.equal(write.csrf, "csrf-test-token", "dashboard mutations must include the CSRF cookie token");
    assert.equal(write.tenant, workspace, "dashboard mutations must include the selected workspace");
  }
});
