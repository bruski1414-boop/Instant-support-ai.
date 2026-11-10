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
  await assert.doesNotReject(async () => page.getByText("Sending…").waitFor());
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
