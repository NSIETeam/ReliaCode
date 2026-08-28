import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { parseWorkspace } from "../src/routes.mjs";

const config = loadConfig({
  NODE_ENV:"test",
  DATABASE_URL:"postgres://unused",
  AUTH_MODE:"development",
  CORS_ORIGINS:"http://localhost:4173",
  LOG_LEVEL:"silent"
});
const db = { query: async (sql) => ({
  rowCount:1,
  rows:[sql.includes("schema_migrations") ? { current:true } : sql.includes("SELECT EXISTS") ? { active:true } : { "?column?":1 }]
}) };

test("health endpoints do not require authentication", async (t) => {
  const app = await buildApp({ config, db });
  t.after(() => app.close());
  const live = await app.inject({ method:"GET", url:"/health/live" });
  const ready = await app.inject({ method:"GET", url:"/health/ready" });
  assert.equal(live.statusCode, 200);
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().schemaVersion, "025_document_objects.sql");
});

test("readiness fails when the database schema is outdated", async (t) => {
  const outdatedDb = { query:async () => ({ rowCount:1,rows:[{ current:false }] }) };
  const app = await buildApp({ config,db:outdatedDb });
  t.after(() => app.close());
  const response = await app.inject({ method:"GET",url:"/health/ready" });
  assert.equal(response.statusCode,503);
  assert.equal(response.json().reason,"schema_outdated");
});

test("readiness rejects a database login that can bypass tenant RLS",async t=>{const unsafeDb={query:async()=>({rowCount:1,rows:[{current:true,rolsuper:true,rolbypassrls:false}]})};const app=await buildApp({config,db:unsafeDb});t.after(()=>app.close());const response=await app.inject({method:"GET",url:"/health/ready"});assert.equal(response.statusCode,503);assert.equal(response.json().reason,"database_role_bypasses_rls");});

test("business routes reject anonymous requests", async (t) => {
  const app = await buildApp({ config, db });
  t.after(() => app.close());
  const response = await app.inject({ method:"GET", url:"/api/v1/me" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "UNAUTHORIZED");
});

test("public verification is anonymous and returns only consumer-safe fields", async (t) => {
  const publicId="c2d3848d-6fe7-4c86-91ed-a34b863c83af";
  const publicDb={ query:async (sql) => {
    if(sql.includes("FROM serialized_objects")) return { rowCount:1,rows:[{ id:"internal-object",public_id:publicId,level:"ITEM",lot:"LOT-01",status:"RECEIVED",created_at:"2026-08-24T00:00:00.000Z",gtin:"06912345678902",product_name:"产品" }] };
    if(sql.includes("FROM trace_events")) return { rowCount:1,rows:[{ event_type:"RECEIVING_STORE",event_time:"2026-08-24T08:00:00.000Z",verification_status:"VERIFIED",organization_id:"must-not-leak" }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const app=await buildApp({config,db:publicDb});
  t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:`/api/public/v1/objects/${publicId}`});
  assert.equal(response.statusCode,200);
  assert.equal(response.headers["cache-control"],"public, max-age=60, stale-while-revalidate=300");
  const body=response.json();
  assert.equal(body.verified,true);
  assert.equal(body.object.publicId,publicId);
  assert.equal(body.events[0].type,"RECEIVING_STORE");
  assert.equal(JSON.stringify(body).includes("internal-object"),false);
  assert.equal(JSON.stringify(body).includes("must-not-leak"),false);
});

test("development principal is normalized and authorized", async (t) => {
  const app = await buildApp({ config, db });
  t.after(() => app.close());
  const principal = JSON.stringify({
    sub:"user-1", tenant_id:"tenant-1", organization_id:"org-1", role:"BRAND_ADMIN", name:"林岚"
  });
  const response = await app.inject({ method:"GET", url:"/api/v1/me", headers:{ "x-reliacode-principal":principal } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().role, "BRAND_ADMIN");
  assert.ok(response.json().capabilities.includes("codes:write"));
});

test("token claims cannot escape the active database scope", async (t) => {
  const inactiveDb = { query:async () => ({ rowCount:1, rows:[{ active:false }] }) };
  const app = await buildApp({ config, db:inactiveDb });
  t.after(() => app.close());
  const principal = JSON.stringify({ sub:"user-2",tenant_id:"unknown",organization_id:"unknown",role:"BRAND_ADMIN" });
  const response = await app.inject({ method:"GET",url:"/api/v1/me",headers:{ "x-reliacode-principal":principal } });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "PRINCIPAL_SCOPE_INACTIVE");
});

test("workspace schema enforces strict shape and serialized size", () => {
  const ids={workspaceId:"11111111-1111-4111-8111-111111111111",accountId:"22222222-2222-4222-8222-222222222222"};
  const state={schemaVersion:1,initialized:true,workspace:{id:ids.workspaceId,brandName:"Demo",createdAt:"2026-08-25"},accounts:[{id:ids.accountId}],currentAccountId:ids.accountId,products:[],codeBatches:[],objects:{},events:[],campaigns:[],ledger:[],risks:[],agentRuns:[]};
  assert.equal(parseWorkspace(state).schemaVersion,1);
  assert.throws(() => parseWorkspace({...state,unexpected:true}), /Unrecognized key/);
  assert.throws(() => parseWorkspace({...state,accounts:[{id:ids.accountId,name:"x".repeat(4*1024*1024)}]}), (error) => error.code === "WORKSPACE_TOO_LARGE" && error.statusCode === 413);
});

test("CORS allows the configured origin and omits ACAO for untrusted origins", async (t) => {
  const app = await buildApp({ config, db });
  t.after(() => app.close());
  const trusted = await app.inject({ method: "GET", url: "/health/live", headers: { origin: "http://localhost:4173" } });
  assert.equal(trusted.statusCode, 200);
  assert.equal(trusted.headers["access-control-allow-origin"], "http://localhost:4173");
  assert.equal(trusted.headers["access-control-allow-credentials"], "true");
  const untrusted = await app.inject({ method: "GET", url: "/health/live", headers: { origin: "https://attacker.example" } });
  assert.equal(untrusted.statusCode, 200);
  assert.equal(untrusted.headers["access-control-allow-origin"], undefined);
  assert.equal(untrusted.headers["access-control-allow-credentials"], undefined);
});

test("CORS preflight rejects an untrusted origin without permission headers", async (t) => {
  const app = await buildApp({ config, db });
  t.after(() => app.close());
  const response = await app.inject({ method: "OPTIONS", url: "/api/v1/me", headers: {
    origin: "https://attacker.example",
    "access-control-request-method": "POST",
    "access-control-request-headers": "authorization,content-type"
  } });
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["access-control-allow-credentials"], undefined);
});
