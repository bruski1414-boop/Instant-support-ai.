"use strict";

require("dotenv").config();

const { createMewsConnectorClient } = require("../mews-connector");

async function main() {
  const clientToken = process.env.MEWS_CLIENT_TOKEN;
  const accessToken = process.env.MEWS_ACCESS_TOKEN;
  if (!clientToken || !accessToken) {
    console.error("Mews demo credentials are not configured.");
    console.error("Set MEWS_CLIENT_TOKEN and MEWS_ACCESS_TOKEN in a private local .env file.");
    process.exitCode = 2;
    return;
  }

  const client = createMewsConnectorClient({
    clientToken,
    accessToken,
    clientName: process.env.MEWS_CLIENT_NAME || "Veyra AI/0.1"
  });

  try {
    const configuration = await client.getConfiguration();
    if (!configuration.enterprise) {
      throw new Error("Mews did not return an enterprise for these credentials.");
    }
    const services = await client.getServices({ count: 100 });
    console.log("Mews demo connection verified.");
    console.log("Property: " + (configuration.enterprise.name || "(name not supplied)"));
    console.log("Property reference: " + (configuration.enterprise.id || "(not supplied)"));
    console.log("Timezone: " + (configuration.enterprise.timeZoneIdentifier || "(not supplied)"));
    console.log("Services returned: " + services.services.length);
    console.log("More services available: " + Boolean(services.cursor));
    console.log("No reservation records or guest information were requested.");
  } catch (error) {
    console.error("Mews demo check failed: " + (error.status ? "HTTP " + error.status : error.message));
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error("Mews demo check failed unexpectedly. No credential values were printed.");
  process.exitCode = 1;
});
