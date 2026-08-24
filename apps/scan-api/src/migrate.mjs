import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { createDatabase } from "./db.mjs";

const config = loadConfig();
const db = createDatabase(config);
const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
let client;

try {
  client = await db.pool.connect();
  await client.query("SELECT pg_advisory_lock(hashtext('reliacode-schema-migrations'))");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const exists = await client.query("SELECT 1 FROM schema_migrations WHERE version=$1", [file]);
    if (exists.rowCount) continue;
    const sql = await readFile(join(migrationDir, file), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    process.stdout.write(`applied ${file}\n`);
  }
} finally {
  if (client) {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('reliacode-schema-migrations'))"); }
    finally { client.release(); }
  }
  await db.close();
}
