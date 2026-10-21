import pg from "pg";
import { configureDatabaseClient,currentDatabaseContext } from "./database-context.mjs";

const { Pool } = pg;

export function createDatabase(config,{PoolClass=Pool}={}) {
  const makePool=(connectionString,applicationName)=>new PoolClass({
    connectionString,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    max: config.DB_POOL_MAX || 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: applicationName
  });
  const pool=makePool(config.DATABASE_URL,"reliacode-tenant-api");
  const systemPool=config.SYSTEM_DATABASE_URL?makePool(config.SYSTEM_DATABASE_URL,"reliacode-system-api"):pool;
  for(const candidate of new Set([pool,systemPool]))candidate.on("error", (error) => console.error(JSON.stringify({ level: "error", message: "postgres pool error", error: error.message })));
  const activePool=()=>currentDatabaseContext().mode==="system"?systemPool:pool;
  const connect=()=>activePool().connect();
  return {
    pool,
    systemPool,
    poolStats(){const pools=[...new Set([pool,systemPool])];return{totalCount:pools.reduce((sum,item)=>sum+item.totalCount,0),idleCount:pools.reduce((sum,item)=>sum+item.idleCount,0),waitingCount:pools.reduce((sum,item)=>sum+item.waitingCount,0)};},
    async query(text,params) {
      const client=await connect();
      try { await client.query("BEGIN");await configureDatabaseClient(client);const result=await client.query(text,params);await client.query("COMMIT");return result; }
      catch(error){await client.query("ROLLBACK");throw error;}
      finally{client.release();}
    },
    async transaction(work) {
      const client = await connect();
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
    async isolationStatus(){
      const probe=async(candidate)=>{const client=await candidate.connect();try{await client.query("BEGIN");await client.query("SELECT set_config('reliacode.system_access','on',true)");const result=await client.query(`SELECT session_user role_name,reliacode_system_access() system_access,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=session_user`);await client.query("ROLLBACK");return result.rows[0];}catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}};
      return{tenant:await probe(pool),system:await probe(systemPool),distinct:pool!==systemPool};
    },
    close: async() => {for(const candidate of new Set([pool,systemPool]))await candidate.end();}
  };
}
