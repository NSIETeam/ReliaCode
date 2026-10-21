import pg from "pg";
import { configureDatabaseClient } from "./database-context.mjs";

const { Pool } = pg;

export function createDatabase(config) {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    max: config.DB_POOL_MAX || 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "reliacode-scan-api"
  });
  pool.on("error", (error) => console.error(JSON.stringify({ level: "error", message: "postgres pool error", error: error.message })));
  return {
    pool,
    async query(text,params) {
      const client=await pool.connect();
      try { await client.query("BEGIN");await configureDatabaseClient(client);const result=await client.query(text,params);await client.query("COMMIT");return result; }
      catch(error){await client.query("ROLLBACK");throw error;}
      finally{client.release();}
    },
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await configureDatabaseClient(client);
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}
