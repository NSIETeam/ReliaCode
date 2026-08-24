import { buildApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createDatabase } from "./db.mjs";

const config = loadConfig();
const db = createDatabase(config);
const app = await buildApp({ config, db });
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "graceful shutdown started");
  const timeout = setTimeout(() => process.exit(1), 15_000).unref();
  try {
    await app.close();
    await db.close();
    clearTimeout(timeout);
    process.exit(0);
  } catch (error) {
    app.log.error({ err:error }, "graceful shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => { app.log.fatal({ err:error }, "uncaught exception"); shutdown("uncaughtException"); });
process.on("unhandledRejection", (error) => { app.log.fatal({ err:error }, "unhandled rejection"); shutdown("unhandledRejection"); });

await app.listen({ host:config.HOST, port:config.PORT });
