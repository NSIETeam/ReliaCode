import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { createDatabase } from "./db.mjs";

const config = loadConfig(process.env.MIGRATION_DATABASE_URL_FILE?{...process.env,DATABASE_URL:undefined,DATABASE_URL_FILE:process.env.MIGRATION_DATABASE_URL_FILE}:process.env);
const db = createDatabase(config);
const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
let client;
const roleIdentifier=(value)=>{if(!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(value||""))throw new Error("Database role name is invalid");return `"${value}"`;};

try {
  client = await db.pool.connect();
  await client.query("SELECT pg_advisory_lock(hashtext('reliacode-schema-migrations'))");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  // Only numbered migrations are executable. This deliberately excludes
  // editor backups and macOS AppleDouble files such as `._001_initial.sql`.
  const files = (await readdir(migrationDir)).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
  for (const file of files) {
    const exists = await client.query("SELECT 1 FROM schema_migrations WHERE version=$1", [file]);
    if (exists.rowCount) continue;
    const sql = await readFile(join(migrationDir, file), "utf8");
    try {
      await client.query("BEGIN");
      // Migration files intentionally contain multiple DDL statements and DO
      // blocks. Force PostgreSQL's simple query protocol; the extended protocol
      // is for one prepared statement and fails with 08P01 on PostgreSQL 17.
      await client.query({ text:sql, queryMode:"simple" });
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    process.stdout.write(`applied ${file}\n`);
  }
  if(config.SYSTEM_DATABASE_ROLE||config.TENANT_DATABASE_ROLE){
    if(!config.SYSTEM_DATABASE_ROLE||!config.TENANT_DATABASE_ROLE||config.SYSTEM_DATABASE_ROLE===config.TENANT_DATABASE_ROLE)throw new Error("Distinct SYSTEM_DATABASE_ROLE and TENANT_DATABASE_ROLE values are required together");
    for(const roleName of [config.SYSTEM_DATABASE_ROLE,config.TENANT_DATABASE_ROLE]){
      const role=await client.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1",[roleName]);
      if(!role.rowCount||!role.rows[0].rolcanlogin||role.rows[0].rolsuper||role.rows[0].rolbypassrls)throw new Error(`${roleName} must exist, allow login, and have neither superuser nor BYPASSRLS privileges`);
    }
    await client.query(`INSERT INTO reliacode_system_database_role(singleton,role_name,registered_at)
      VALUES(true,$1,now()) ON CONFLICT(singleton) DO UPDATE SET role_name=excluded.role_name,registered_at=excluded.registered_at`,[config.SYSTEM_DATABASE_ROLE]);
    for(const roleName of [config.SYSTEM_DATABASE_ROLE,config.TENANT_DATABASE_ROLE]){
      const role=roleIdentifier(roleName);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
      await client.query(`REVOKE ALL ON reliacode_system_database_role FROM ${role}`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${role}`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${role}`);
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role}`);
    }
  }
} finally {
  if (client) {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('reliacode-schema-migrations'))"); }
    finally { client.release(); }
  }
  await db.close();
}
