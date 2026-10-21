import assert from "node:assert/strict";
import pg from "pg";

if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required for the RLS integration test");
const admin=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==="true"?{rejectUnauthorized:true}:false});
const tenantA="a1000000-0000-4000-8000-000000000001",tenantB="b1000000-0000-4000-8000-000000000002";
await admin.connect();
try{
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='reliacode_rls_test') THEN CREATE ROLE reliacode_rls_test NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$");
  await admin.query("GRANT USAGE ON SCHEMA public TO reliacode_rls_test");
  await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO reliacode_rls_test");
  await admin.query("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO reliacode_rls_test");
  await admin.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO reliacode_rls_test");
  await admin.query("BEGIN");await admin.query("SET LOCAL ROLE reliacode_rls_test");await admin.query("SELECT set_config('reliacode.system_access','on',true)");
  await admin.query("INSERT INTO tenants(id,name) VALUES($1,'RLS tenant A'),($2,'RLS tenant B') ON CONFLICT(id) DO NOTHING",[tenantA,tenantB]);
  await admin.query("INSERT INTO products(tenant_id,sku,name) VALUES($1,'RLS-A','A'),($2,'RLS-B','B') ON CONFLICT(tenant_id,sku) DO NOTHING",[tenantA,tenantB]);await admin.query("COMMIT");

  const forced=await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='products'::regclass");assert.deepEqual(forced.rows[0],{relrowsecurity:true,relforcerowsecurity:true});
  await admin.query("BEGIN");await admin.query("SET LOCAL ROLE reliacode_rls_test");await admin.query("SELECT set_config('reliacode.system_access','off',true),set_config('reliacode.tenant_id',$1,true)",[tenantA]);
  const visible=await admin.query("SELECT tenant_id,sku FROM products ORDER BY sku");assert.deepEqual(visible.rows,[{tenant_id:tenantA,sku:"RLS-A"}]);
  const hidden=await admin.query("SELECT id FROM products WHERE tenant_id=$1",[tenantB]);assert.equal(hidden.rowCount,0);
  await assert.rejects(()=>admin.query("INSERT INTO products(tenant_id,sku,name) VALUES($1,'RLS-CROSS','blocked')",[tenantB]),error=>error.code==="42501");await admin.query("ROLLBACK");
  process.stdout.write("RLS INTEGRATION PASS: forced policy hides cross-tenant rows and blocks cross-tenant writes\n");
}finally{await admin.end();}
