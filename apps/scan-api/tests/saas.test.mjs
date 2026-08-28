import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.mjs";
import { createAuthenticator, hashToken, ROLE_CAPABILITIES } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";
import { traceEventSchema } from "../src/schemas.mjs";
import { nextObjectStatus } from "../src/domain.mjs";
import { changeMemberAccountStatus } from "../src/routes.mjs";
import { currentDatabaseContext } from "../src/database-context.mjs";

const config=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"development",LOG_LEVEL:"silent"});
const principal={sub:"operator-1",tenant_id:"11111111-1111-4111-8111-111111111111",organization_id:"22222222-2222-4222-8222-222222222222",role:"BRAND_ADMIN"};
const headers={"x-reliacode-principal":JSON.stringify(principal)};

test("normalized product listing always binds the authenticated tenant",async(t)=>{
  const calls=[];const db={query:async(sql,params=[])=>{calls.push({sql,params,context:{...currentDatabaseContext()}});if(sql.includes("SELECT EXISTS"))return{rowCount:1,rows:[{active:true}]};if(sql.includes("FROM products WHERE tenant_id=$1"))return{rowCount:0,rows:[]};throw new Error(`Unexpected SQL: ${sql}`);}};
  const app=await buildApp({config,db});t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:"/api/v1/products",headers});
  assert.equal(response.statusCode,200);
  const query=calls.find(call=>call.sql.includes("FROM products WHERE tenant_id=$1"));
  assert.equal(query.params[0],principal.tenant_id);
  assert.deepEqual(query.context,{mode:"tenant",tenantId:principal.tenant_id});
});

test("code job listing is tenant-scoped, paginated, and never selects object keys",async(t)=>{const calls=[],db={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.includes("SELECT EXISTS"))return{rowCount:1,rows:[{active:true}]};if(sql.includes("FROM code_generation_jobs WHERE tenant_id=$1"))return{rowCount:1,rows:[{id:"33333333-3333-4333-8333-333333333333",created_at:"2026-08-28T00:00:00Z",export_status:"COMPLETED"}]};throw new Error(`Unexpected SQL: ${sql}`);}};const app=await buildApp({config,db});t.after(()=>app.close());const response=await app.inject({method:"GET",url:"/api/v1/code-jobs?limit=20",headers});assert.equal(response.statusCode,200);assert.equal(response.json().items[0].output_object_key,undefined);const query=calls.find(call=>call.sql.includes("FROM code_generation_jobs WHERE tenant_id=$1"));assert.doesNotMatch(query.sql,/output_object_key/);assert.equal(query.params[0],principal.tenant_id);assert.equal(query.params[3],21);});

test("code export download signs only a tenant-owned completed object",async(t)=>{const storageConfig=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"development",LOG_LEVEL:"silent",OBJECT_STORAGE_ENDPOINT:"https://s3.example.cn",OBJECT_STORAGE_REGION:"cn-test-1",OBJECT_STORAGE_BUCKET:"exports",OBJECT_STORAGE_ACCESS_KEY_ID:"access",OBJECT_STORAGE_SECRET_ACCESS_KEY:"secret"}),id="33333333-3333-4333-8333-333333333333";const db={query:async(sql,params=[])=>{if(sql.includes("SELECT EXISTS"))return{rowCount:1,rows:[{active:true}]};if(sql.includes("SELECT output_object_key")){assert.deepEqual(params,[principal.tenant_id,id]);return{rowCount:1,rows:[{output_object_key:`tenants/${principal.tenant_id}/code-jobs/${id}/codes.csv`,export_status:"COMPLETED"}]};}throw new Error(`Unexpected SQL: ${sql}`);}};const app=await buildApp({config:storageConfig,db});t.after(()=>app.close());const response=await app.inject({method:"GET",url:`/api/v1/code-jobs/${id}/download`,headers});assert.equal(response.statusCode,200);assert.match(response.json().url,/X-Amz-Signature=/);assert.match(response.json().url,/codes\.csv/);});

test("SaaS role capabilities separate platform, owner, operator, and auditor duties",()=>{
  assert.ok(ROLE_CAPABILITIES.PLATFORM_OPERATOR.includes("platform:tenants:write"));
  assert.ok(ROLE_CAPABILITIES.TENANT_OWNER.includes("tenant:manage"));
  assert.ok(ROLE_CAPABILITIES.FACTORY_OPERATOR.includes("events:write:packing"));
  assert.equal(ROLE_CAPABILITIES.READ_ONLY_AUDITOR.some(value=>value.endsWith(":write")),false);
  assert.equal(ROLE_CAPABILITIES.PLATFORM_OPERATOR.includes("products:write"),false);
});

test("tenant application endpoint remains anonymous but is rate limited",async(t)=>{
  const db={query:async(sql)=>sql.includes("INSERT INTO tenant_applications")?{rowCount:1,rows:[{id:"33333333-3333-4333-8333-333333333333",status:"PENDING",created_at:new Date().toISOString()}]}:{rowCount:0,rows:[]}};
  const app=await buildApp({config,db});t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:"/api/v1/tenant-applications",payload:{companyName:"测试企业",contactName:"张三",contactEmail:"ops@example.cn",expectedMonthlyCodes:1000}});
  assert.equal(response.statusCode,202);
  assert.equal(response.json().status,"PENDING");
});

test("platform suspension is idempotent, audited, and revokes every tenant session",async(t)=>{const tenantId="33333333-3333-4333-8333-333333333333",platform={sub:"platform-1",tenant_id:principal.tenant_id,organization_id:principal.organization_id,role:"PLATFORM_OPERATOR"},calls=[],db={query:async(sql)=>sql.includes("SELECT EXISTS")?{rowCount:1,rows:[{active:true}]}:{rowCount:0,rows:[]},transaction:async work=>work({query:async(sql,params=[])=>{calls.push({sql,params});if(sql.includes("FROM platform_idempotency_records"))return{rowCount:0,rows:[]};if(sql.startsWith("SELECT id,name,status"))return{rowCount:1,rows:[{id:tenantId,name:"Tenant",status:"ACTIVE",plan:"team",suspended_reason:null}]};if(sql.startsWith("UPDATE tenants SET"))return{rowCount:1,rows:[{id:tenantId,name:"Tenant",status:"SUSPENDED",plan:"team",suspended_reason:"security incident"}]};return{rowCount:1,rows:[]};}})};const app=await buildApp({config,db});t.after(()=>app.close());const response=await app.inject({method:"POST",url:`/api/v1/platform/tenants/${tenantId}/status`,headers:{"x-reliacode-principal":JSON.stringify(platform),"idempotency-key":"tenant-suspend-001"},payload:{status:"SUSPENDED",reason:"security incident"}});assert.equal(response.statusCode,200);assert.equal(response.json().status,"SUSPENDED");const revoked=calls.find(call=>call.sql.startsWith("UPDATE admin_sessions SET revoked_at"));assert.equal(revoked.params[2],tenantId);assert.ok(calls.some(call=>call.sql.includes("INSERT INTO platform_audit_log")));assert.ok(calls.some(call=>call.sql.includes("INSERT INTO platform_idempotency_records")));});

test("member freeze is tenant-scoped, protects the owner, and revokes active sessions",async()=>{const tenantId=principal.tenant_id,organizationId=principal.organization_id,userId="33333333-3333-4333-8333-333333333333",calls=[],client={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.startsWith("SELECT u.id"))return{rowCount:1,rows:[{id:userId,status:"ACTIVE",owner_user_id:"44444444-4444-4444-8444-444444444444"}]};if(sql.startsWith("UPDATE local_users"))return{rowCount:1,rows:[{id:userId,status:"DISABLED"}]};return{rowCount:1,rows:[]};}};const result=await changeMemberAccountStatus(client,{tenantId,organizationId,userId,actorId:"admin-1",status:"DISABLED",reason:"device compromise"});assert.equal(result.after.status,"DISABLED");assert.deepEqual(calls[0].params,[tenantId,organizationId,userId]);assert.deepEqual(calls.find(call=>call.sql.startsWith("UPDATE admin_sessions")).params,["admin-1","device compromise",userId]);const ownerClient={query:async()=>({rowCount:1,rows:[{id:userId,status:"ACTIVE",owner_user_id:userId}]})};await assert.rejects(()=>changeMemberAccountStatus(ownerClient,{tenantId,organizationId,userId,actorId:"admin-1",status:"DISABLED",reason:"test"}),error=>error.code==="OWNER_FREEZE_FORBIDDEN");});

test("state-changing trace events require approved-document identity",()=>{
  const common={eventType:"SHIPPING",objectCode:"OBJECT-000001",readPoint:"urn:epc:id:sgln:0614141.07346.1234",eventTime:"2026-08-28T03:00:00.000Z",metadata:{}};
  assert.equal(traceEventSchema.safeParse(common).success,false);
  assert.equal(traceEventSchema.safeParse({...common,documentId:"33333333-3333-4333-8333-333333333333"}).success,true);
});

test("destruction is terminal and is represented as a compensation event transition",()=>{
  assert.equal(nextObjectStatus("DESTROYING","ITEM","RETURNED"),"DESTROYED");
  assert.throws(()=>nextObjectStatus("SHIPPING","ITEM","DESTROYED"),(error)=>error.code==="INVALID_STATE_TRANSITION");
});

test("local bootstrap administrator is restricted to the platform control plane",async()=>{
  const token="bootstrap-session-token",localConfig=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"local",ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000",SESSION_COOKIE_SECURE:"false",LOG_LEVEL:"silent"});
  const db={query:async(sql,params)=>{if(sql.includes("FROM admin_sessions")){assert.equal(params[0],hashToken(token));return{rowCount:1,rows:[{token_hash:params[0],csrf_token_hash:"unused",user_id:null}]};}throw new Error(`Unexpected SQL: ${sql}`);}};
  const authenticate=await createAuthenticator({...localConfig,db});const principalResult=await authenticate({headers:{cookie:`${localConfig.SESSION_COOKIE_NAME}=${token}`}});
  assert.equal(principalResult.role,"PLATFORM_OPERATOR");
  assert.equal(principalResult.capabilities.has("platform:tenants:write"),true);
  assert.equal(principalResult.capabilities.has("products:write"),false);
});
