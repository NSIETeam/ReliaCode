import assert from "node:assert/strict";
import pg from "pg";

if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required for the RLS integration test");
const admin=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==="true"?{rejectUnauthorized:true}:false});
const tenantA="a1000000-0000-4000-8000-000000000001",tenantB="b1000000-0000-4000-8000-000000000002";
const tenantRole=process.env.TENANT_DATABASE_ROLE,systemRole=process.env.SYSTEM_DATABASE_ROLE;
assert.match(tenantRole,/^[a-z_][a-z0-9_]*$/);assert.match(systemRole,/^[a-z_][a-z0-9_]*$/);
await admin.connect();
try{
  await admin.query(`SET SESSION AUTHORIZATION ${tenantRole}`);await admin.query("BEGIN");await admin.query("SELECT set_config('reliacode.system_access','on',true)");
  const forgedSystem=await admin.query("SELECT reliacode_system_access() allowed");assert.equal(forgedSystem.rows[0].allowed,false);
  await assert.rejects(()=>admin.query("INSERT INTO tenants(id,name) VALUES($1,'forged system tenant')",[tenantA]),error=>error.code==="42501");await admin.query("ROLLBACK");await admin.query("RESET SESSION AUTHORIZATION");

  await admin.query(`SET SESSION AUTHORIZATION ${systemRole}`);await admin.query("BEGIN");await admin.query("SELECT set_config('reliacode.system_access','on',true)");
  const trustedSystem=await admin.query("SELECT reliacode_system_access() allowed");assert.equal(trustedSystem.rows[0].allowed,true);
  await admin.query("INSERT INTO tenants(id,name) VALUES($1,'RLS tenant A'),($2,'RLS tenant B') ON CONFLICT(id) DO NOTHING",[tenantA,tenantB]);
  await admin.query("INSERT INTO products(tenant_id,sku,name) VALUES($1,'RLS-A','A'),($2,'RLS-B','B') ON CONFLICT(tenant_id,sku) DO NOTHING",[tenantA,tenantB]);await admin.query("COMMIT");await admin.query("RESET SESSION AUTHORIZATION");

  const forced=await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='products'::regclass");assert.deepEqual(forced.rows[0],{relrowsecurity:true,relforcerowsecurity:true});
  await admin.query(`SET SESSION AUTHORIZATION ${tenantRole}`);await admin.query("BEGIN");await admin.query("SELECT set_config('reliacode.system_access','off',true),set_config('reliacode.tenant_id',$1,true)",[tenantA]);
  const visible=await admin.query("SELECT tenant_id,sku FROM products ORDER BY sku");assert.deepEqual(visible.rows,[{tenant_id:tenantA,sku:"RLS-A"}]);
  const hidden=await admin.query("SELECT id FROM products WHERE tenant_id=$1",[tenantB]);assert.equal(hidden.rowCount,0);
  await assert.rejects(()=>admin.query("INSERT INTO products(tenant_id,sku,name) VALUES($1,'RLS-CROSS','blocked')",[tenantB]),error=>error.code==="42501");await admin.query("ROLLBACK");await admin.query("RESET SESSION AUTHORIZATION");
  process.stdout.write("RLS INTEGRATION PASS: unregistered roles cannot forge system access; forced policy hides cross-tenant rows and blocks writes\n");
}finally{await admin.end();}
