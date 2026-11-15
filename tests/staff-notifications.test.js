"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { deliverStaffEscalation, shouldRetryStaffNotification, encryptSecret, decryptSecret,
  validateWebhookUrl, isPublicIPv4, resolvePublicAddress } = require("../staff-notifications");

const input = {
  organization: { id: "org-1", slug: "aster-house", name: "Aster House" },
  conversationId: "conversation-1", reason: "Guest requested staff assistance.",
  idempotencyKey: "escalation-123", webhookUrl: "https://hooks.hotel.com/veyra",
  webhookSecret: "test-only-secret"
};
function fakeRequest(responseStatus = 200) {
  let captured;
  const requestImpl = (options, callback) => {
    captured = { options, body: "" };
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = error => req.emit("error", error);
    req.end = body => {
      captured.body = body;
      const response = { statusCode: responseStatus, resume() {} };
      callback(response);
    };
    return req;
  };
  return { requestImpl, get captured() { return captured; } };
}
const publicLookup = async (_host, options) => {
  assert.equal(options.all, true);
  return [{ address: "93.184.216.34", family: 4 }];
};

test("staff escalation is explicitly not configured when credentials are absent", async () => {
  const result = await deliverStaffEscalation({ ...input, webhookUrl: "", webhookSecret: "" });
  assert.deepEqual(result, { configured: false, delivered: false, status: "not_configured" });
});

test("staff escalation sends a signed event through a pinned public address", async () => {
  const fake = fakeRequest();
  const result = await deliverStaffEscalation({ ...input, lookupImpl: publicLookup, requestImpl: fake.requestImpl });
  assert.deepEqual(result, { configured: true, delivered: true, status: "delivered" });
  const { options, body } = fake.captured;
  assert.equal(options.hostname, "hooks.hotel.com");
  assert.equal(options.servername, "hooks.hotel.com");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.lookup("hooks.hotel.com", {}, (_error, address, family) => {
    assert.equal(address, "93.184.216.34");
    assert.equal(family, 4);
  }), undefined);
  assert.equal(options.method, "POST");
  const expected = crypto.createHmac("sha256", input.webhookSecret).update(body).digest("hex");
  assert.equal(options.headers["x-veyra-signature"], expected);
  assert.equal(options.headers["idempotency-key"], input.idempotencyKey);
  const payload = JSON.parse(body);
  assert.equal(payload.event, "veyra.escalation.created");
  assert.equal(payload.conversationId, input.conversationId);
  assert.equal(payload.reason, input.reason);
});

test("non-success webhook responses are reported as failed delivery", async () => {
  const fake = fakeRequest(503);
  const result = await deliverStaffEscalation({ ...input, lookupImpl: publicLookup, requestImpl: fake.requestImpl });
  assert.deepEqual(result, { configured: true, delivered: false, status: "failed" });
});

test("DNS failures fail closed without attempting a request", async () => {
  let requested = false;
  const result = await deliverStaffEscalation({ ...input,
    lookupImpl: async () => { throw new Error("DNS failure"); },
    requestImpl: () => { requested = true; throw new Error("must not run"); }
  });
  assert.deepEqual(result, { configured: true, delivered: false, status: "failed" });
  assert.equal(requested, false);
});

test("mixed public and private DNS answers are rejected before connection", async () => {
  let requested = false;
  const result = await deliverStaffEscalation({ ...input,
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
    requestImpl: () => { requested = true; throw new Error("must not run"); }
  });
  assert.equal(result.delivered, false);
  assert.equal(requested, false);
});

test("failed staff notifications retry only while an escalation is open and attempts remain", () => {
  for (const attempts of [0, 1, 2]) assert.equal(shouldRetryStaffNotification({
    needsHuman: true, createdEscalation: false, notificationStatus: "failed", notificationAttempts: attempts
  }), true);
  assert.equal(shouldRetryStaffNotification({ needsHuman: true, createdEscalation: false, notificationStatus: "failed", notificationAttempts: 3 }), false);
  assert.equal(shouldRetryStaffNotification({ needsHuman: true, createdEscalation: false, notificationStatus: "delivered", notificationAttempts: 1 }), false);
  assert.equal(shouldRetryStaffNotification({ needsHuman: false, createdEscalation: false, notificationStatus: "failed", notificationAttempts: 1 }), false);
});

test("hotel webhook secrets are encrypted and authenticated on decrypt", () => {
  const secret = "a-long-random-hotel-webhook-secret-value";
  const key = "test-encryption-key-with-more-than-32-characters";
  const encrypted = encryptSecret(secret, key);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptSecret(encrypted, key), secret);
  assert.throws(() => decryptSecret(encrypted, "a-different-key-with-more-than-32-characters"));
});

test("webhook URLs require public HTTPS hostnames", () => {
  assert.equal(validateWebhookUrl("https://hooks.hotel.com/events"), "https://hooks.hotel.com/events");
  for (const url of [
    "http://hooks.hotel.com/events", "https://localhost/hook", "https://127.0.0.1/hook",
    "https://10.0.0.8/hook", "https://192.168.1.2/hook", "https://172.16.0.1/hook",
    "https://user:pass@hooks.hotel.com/hook", "https://[::1]/hook", "https://[2001:4860:4860::8888]/hook",
    "https://service.example.test/hook", "https://hooks.hotel.com./hook"
  ]) assert.throws(() => validateWebhookUrl(url), undefined, url);
});

test("public IPv4 filter rejects special-use, private and loopback ranges", () => {
  for (const ip of ["0.1.2.3","10.0.0.1","100.64.0.1","127.0.0.1","169.254.1.1",
    "172.16.0.1","192.0.2.1","192.168.1.1","198.18.0.1","198.51.100.2",
    "203.0.113.1","224.0.0.1","255.255.255.255","::1"]) assert.equal(isPublicIPv4(ip), false, ip);
  assert.equal(isPublicIPv4("93.184.216.34"), true);
});

test("DNS resolution is bounded by a timeout", async () => {
  await assert.rejects(() => resolvePublicAddress("slow.hotel.com", () => new Promise(() => {}), 5), /timed out/);
});

test("DNS resolver requires all answers to be public IPv4", async () => {
  const result = await resolvePublicAddress("hooks.hotel.com", publicLookup);
  assert.deepEqual(result, { address: "93.184.216.34", family: 4 });
  await assert.rejects(() => resolvePublicAddress("hooks.hotel.com", async () => [
    { address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }
  ]));
});

test("integration test event is signed and marked as a test without guest details", async () => {
  const fake = fakeRequest();
  await deliverStaffEscalation({ ...input, event: "veyra.integration.test", test: true,
    lookupImpl: publicLookup, requestImpl: fake.requestImpl });
  const payload = JSON.parse(fake.captured.body);
  assert.equal(payload.event, "veyra.integration.test");
  assert.equal(payload.test, true);
  assert.equal(payload.conversationId, undefined);
  assert.equal(fake.captured.options.headers["x-veyra-signature"],
    crypto.createHmac("sha256", input.webhookSecret).update(fake.captured.body).digest("hex"));
});
