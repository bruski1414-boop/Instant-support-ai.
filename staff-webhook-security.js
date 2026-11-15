"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");
const { URL } = require("node:url");

function keyBytes(value) {
  const key = Buffer.from(String(value || ""), "base64");
  if (key.length !== 32) throw new Error("STAFF_WEBHOOK_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

function encryptWebhookConfig(config, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
}

function decryptWebhookConfig(value, key) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) throw new Error("Stored staff integration configuration is invalid.");
  const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(key), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
}

const blocked = new net.BlockList();
for (const [subnet, prefix] of [
  ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],
  ["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],
  ["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],
  ["224.0.0.0",4],["240.0.0.0",4]
]) blocked.addSubnet(subnet,prefix,"ipv4");
for (const [subnet,prefix] of [
  ["::",128],["::1",128],["fc00::",7],["fe80::",10],["ff00::",8],
  ["2001:db8::",32]
]) blocked.addSubnet(subnet,prefix,"ipv6");

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 4) return !blocked.check(address,"ipv4");
  return address.toLowerCase().startsWith("2") || address.toLowerCase().startsWith("3")
    ? !blocked.check(address,"ipv6") : false;
}

async function resolvePublicWebhook(value, lookup = dns.lookup) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid HTTPS staff webhook URL."); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash) {
    throw new Error("Staff webhook URLs must use HTTPS on port 443 and cannot contain credentials or fragments.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/,"");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || net.isIP(hostname)) {
    throw new Error("Staff webhook must use a public hostname, not a local or IP address.");
  }
  const records = await lookup(hostname,{all:true,verbatim:true});
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new Error("Staff webhook hostname must resolve only to public IP addresses.");
  }
  return { url, records };
}

function postSignedWebhook(urlValue, secret, event, options = {}) {
  return new Promise(async (resolve,reject) => {
    let resolved;
    try { resolved = await resolvePublicWebhook(urlValue,options.lookup || dns.lookup); }
    catch (error) { reject(error); return; }
    const {url,records} = resolved;
    const body = JSON.stringify(event);
    const signature = crypto.createHmac("sha256",secret).update(body).digest("hex");
    const address = records[0];
    const requestImpl = options.requestImpl || https.request;
    const request = requestImpl({
      protocol:"https:",hostname:url.hostname,port:443,path:url.pathname+url.search,method:"POST",
      servername:url.hostname,agent:false,
      lookup:(_host,_opts,callback)=>callback(null,address.address,address.family),
      headers:{"content-type":"application/json","content-length":Buffer.byteLength(body),"x-veyra-signature":signature}
    },response=>{
      response.resume();
      resolve({ok:response.statusCode>=200&&response.statusCode<300,statusCode:response.statusCode});
    });
    request.setTimeout(options.timeoutMs || 5000,()=>request.destroy(new Error("Staff webhook timed out.")));
    request.on("error",reject);
    request.end(body);
  });
}

module.exports = { encryptWebhookConfig, decryptWebhookConfig, resolvePublicWebhook, postSignedWebhook, isPublicAddress };
