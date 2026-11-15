"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  encryptWebhookConfig,
  decryptWebhookConfig,
  resolvePublicWebhook,
  postSignedWebhook,
  isPublicAddress
} = require("../staff-webhook-security");

const key = Buffer.alloc(32, 7).toString("base64");

test("hotel webhook configuration is encrypted and round-trips with its dedicated key", () => {
  const config = { url: "https://hotel.example/webhook", secret: "hotel-secret" };
  const encrypted = encryptWebhookConfig(config, key);
  assert.notEqual(encrypted, JSON.stringify(config));
  assert.equal(encrypted.includes(config.secret), false);
  assert.deepEqual(decryptWebhookConfig(encrypted, key), config);
  assert.throws(() => decryptWebhookConfig(encrypted, Buffer.alloc(32, 8).toString("base64")));
});

test("webhook encryption refuses missing or incorrectly sized platform keys", () => {
  assert.throws(() => encryptWebhookConfig({ url: "https://example.com", secret: "x" }, ""));
  assert.throws(() => encryptWebhookConfig({ url: "https://example.com", secret: "x" }, Buffer.alloc(16).toString("base64")));
});

test("webhook URL validation requires HTTPS, a hostname and public DNS answers", async () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const valid = await resolvePublicWebhook("https://hotel.example/hooks/veyra", lookup);
  assert.equal(valid.url.hostname, "hotel.example");
  await assert.rejects(resolvePublicWebhook("http://hotel.example/hooks", lookup));
  await assert.rejects(resolvePublicWebhook("https://127.0.0.1/hooks", lookup));
  await assert.rejects(resolvePublicWebhook("https://localhost/hooks", lookup));
  await assert.rejects(resolvePublicWebhook("https://hotel.example/hooks", async () => [{ address: "10.0.0.8", family: 4 }]));
  await assert.rejects(resolvePublicWebhook("https://hotel.example/hooks", async () => [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.2", family: 4 }]));
});

test("public address validation rejects private, loopback and documentation ranges", () => {
  for (const address of ["10.0.0.1","127.0.0.1","169.254.1.1","172.16.0.1","192.168.1.1","192.0.2.4","::1","fc00::1","fe80::1","2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
});


test("signed HTTPS delivery pins the validated public IP and sends the HMAC header", async () => {
  const secret = "hotel-webhook-signing-secret";
  const event = { event: "veyra.integration.test", organizationId: "hotel-a" };
  let requestOptions;
  let requestBody;
  const result = await postSignedWebhook("https://hotel.example/hooks?key=hidden", secret, event, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl: (options, onResponse) => {
      requestOptions = options;
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.end = body => {
        requestBody = body;
        onResponse({ statusCode: 202, resume() {} });
      };
      return request;
    }
  });
  assert.equal(result.ok, true);
  assert.equal(requestOptions.hostname, "hotel.example");
  assert.equal(requestOptions.servername, "hotel.example");
  assert.equal(requestOptions.agent, false);
  assert.equal(requestOptions.path, "/hooks?key=hidden");
  assert.equal(requestBody, JSON.stringify(event));
  const expected = crypto.createHmac("sha256", secret).update(requestBody).digest("hex");
  assert.equal(requestOptions.headers["x-veyra-signature"], expected);
  const pinned = await new Promise((resolve, reject) => {
    requestOptions.lookup("hotel.example", {}, (error, address, family) => error ? reject(error) : resolve({ address, family }));
  });
  assert.deepEqual(pinned, { address: "93.184.216.34", family: 4 });
});
