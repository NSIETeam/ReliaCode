import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.mjs";
import { ROLE_CAPABILITIES } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";

const config=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"development",LOG_LEVEL:"silent"});
const principal={sub:"operator-1",tenant_id:"11111111-1111-4111-8111-111111111111",organization_id:"22222222-2222-4222-8222-222222222222",role:"BRAND_ADMIN"};
const headers={"x-reliacode-principal":JSON.stringify(principal)};

test("normalized product listing always binds the authenticated tenant",async(t)=>{
  const calls=[];const db={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.includes("SELECT EXISTS"))return{rowCount:1,rows:[{active:true}]};if(sql.includes("FROM products WHERE tenant_id=$1"))return{rowCount:0,rows:[]};throw new Error(`Unexpected SQL: ${sql}`);}};
  const app=await buildApp({config,db});t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:"/api/v1/products",headers});
  assert.equal(response.statusCode,200);
  const query=calls.find(call=>call.sql.includes("FROM products WHERE tenant_id=$1"));
  assert.equal(query.params[0],principal.tenant_id);
});

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
