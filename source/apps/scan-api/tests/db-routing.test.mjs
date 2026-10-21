import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../src/db.mjs";
import { runWithDatabaseContext,useTenantDatabaseContext } from "../src/database-context.mjs";

test("tenant requests and trusted system work use distinct connection pools",async()=>{
  const pools=[];
  class FakePool{
    constructor(options){this.options=options;this.connections=0;this.totalCount=0;this.idleCount=0;this.waitingCount=0;pools.push(this);}
    on(){}
    async connect(){this.connections+=1;return{query:async()=>({rowCount:0,rows:[]}),release(){}};}
    async end(){this.ended=true;}
  }
  const db=createDatabase({DATABASE_URL:"postgres://tenant",SYSTEM_DATABASE_URL:"postgres://system",DATABASE_SSL:false,DB_POOL_MAX:3},{PoolClass:FakePool});
  await runWithDatabaseContext(async()=>db.query("SELECT system work"));
  await runWithDatabaseContext(async()=>{useTenantDatabaseContext("11111111-1111-4111-8111-111111111111");await db.query("SELECT tenant work");});
  assert.equal(pools.length,2);
  assert.equal(pools.find(pool=>pool.options.connectionString==="postgres://system").connections,1);
  assert.equal(pools.find(pool=>pool.options.connectionString==="postgres://tenant").connections,1);
  await db.close();
  assert.equal(pools.every(pool=>pool.ended),true);
});
