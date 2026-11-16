"use strict";

require("dotenv").config();
const { Pool } = require("pg");
const { createMewsConnectionStore } = require("../mews-connection-store");
const { createMewsInboxProcessor } = require("../mews-inbox-processor");

async function main() {
  if (process.env.MEWS_INBOX_WORKER_ENABLED !== "true") {
    throw new Error("MEWS_INBOX_WORKER_ENABLED must be explicitly true.");
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  if (!process.env.STORAGE_TOKEN_ENCRYPTION_KEY) throw new Error("STORAGE_TOKEN_ENCRYPTION_KEY is required.");

  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 5000
  });
  const mewsStore = createMewsConnectionStore({
    db,
    encryptionKey: process.env.STORAGE_TOKEN_ENCRYPTION_KEY
  });
  const processor = createMewsInboxProcessor({ db, mewsStore, batchSize: 10, maxAttempts: 5 });
  let stopping = false;
  let active = false;
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    while (!stopping) {
      active = true;
      try {
        const result = await processor.processBatch();
        if (result.claimed > 0) {
          console.log("Mews inbox batch completed:", JSON.stringify(result));
        } else {
          await wait(3000);
        }
      } catch {
        // Provider and database error messages can contain property data; log no raw payloads.
        console.error("Mews inbox batch failed; the worker will retry.");
        await wait(5000);
      } finally {
        active = false;
      }
    }
    while (active) await wait(100);
  } finally {
    await db.end();
  }
}

main().catch(async () => {
  console.error("Mews inbox worker could not start. Check its required configuration.");
  process.exitCode = 1;
});
