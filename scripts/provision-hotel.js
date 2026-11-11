#!/usr/bin/env node
"use strict";

const required = ["VEYRA_BASE_URL", "PLATFORM_PROVISIONING_TOKEN", "HOTEL_NAME", "HOTEL_OWNER_EMAIL", "HOTEL_OWNER_PASSWORD"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error("Missing required environment variables: " + missing.join(", "));
  process.exit(2);
}

let base;
try {
  base = new URL(process.env.VEYRA_BASE_URL);
} catch {
  console.error("VEYRA_BASE_URL must be a valid HTTPS URL.");
  process.exit(2);
}
if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
  console.error("Use HTTPS for the Veyra platform URL.");
  process.exit(2);
}
if (process.env.HOTEL_OWNER_PASSWORD.length < 12 || process.env.HOTEL_OWNER_PASSWORD.length > 200) {
  console.error("HOTEL_OWNER_PASSWORD must be between 12 and 200 characters.");
  process.exit(2);
}

async function main() {
  const endpoint = new URL("/api/platform/organizations", base);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-platform-provisioning-token": process.env.PLATFORM_PROVISIONING_TOKEN
    },
    body: JSON.stringify({
      organizationName: process.env.HOTEL_NAME,
      email: process.env.HOTEL_OWNER_EMAIL,
      password: process.env.HOTEL_OWNER_PASSWORD
    }),
    signal: AbortSignal.timeout(15000)
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Hotel workspace creation failed (" + response.status + "): " + (result.error || "Unexpected platform response."));
    process.exitCode = 1;
    return;
  }

  console.log("Hotel workspace created.");
  console.log("Hotel: " + result.organization.name);
  console.log("Workspace slug: " + result.organization.slug);
  console.log("Owner email: " + result.owner.email);
  console.log("Share the workspace slug and owner login details with that hotel's authorized owner using a secure channel.");
  console.log("Remove the HOTEL_OWNER_PASSWORD and PLATFORM_PROVISIONING_TOKEN from your shell environment when finished.");
}

main().catch((error) => {
  console.error("Could not reach Veyra. Check the platform URL and try again.");
  process.exitCode = 1;
});
