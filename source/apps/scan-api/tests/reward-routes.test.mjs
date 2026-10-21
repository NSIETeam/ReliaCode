import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";

const config=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"development",LOG_LEVEL:"silent"});
const tenantId="11111111-1111-4111-8111-111111111111",organizationId="22222222-2222-4222-8222-222222222222",campaignId="33333333-3333-4333-8333-333333333333",claimId="44444444-4444-4444-8444-444444444444";
const principal=(role="BRAND_ADMIN")=>({"x-reliacode-principal":JSON.stringify({sub:"operator-1",tenant_id:tenantId,organization_id:organizationId,role})});
const baseDb=(client)=>({query:async sql=>sql.includes("SELECT EXISTS")?{rowCount:1,rows:[{active:true}]}:{rowCount:0,rows:[]},transaction:async work=>work(client)});

test("campaign creation stores an unpublished version and one audit record",async t=>{
  const calls=[],campaign={id:campaignId,tenant_id:tenantId,status:"DRAFT"},version={id:"55555555-5555-4555-8555-555555555555",campaign_id:campaignId,version:1,published_at:null};
  const client={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.includes("FROM idempotency_records"))return{rowCount:0,rows:[]};if(sql.startsWith("INSERT INTO campaigns"))return{rowCount:1,rows:[campaign]};if(sql.startsWith("INSERT INTO campaign_versions"))return{rowCount:1,rows:[version]};return{rowCount:1,rows:[]};}};
  const app=await buildApp({config,db:baseDb(client)});t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:"/api/v1/campaigns",headers:{...principal(),"idempotency-key":"campaign-create-0001"},payload:{code:"RECEIVE-2026",name:"渠道收货试点",startsAt:"2026-09-01T00:00:00+08:00",endsAt:"2026-12-31T23:59:59+08:00",budgetPoints:100000,rule:{triggerType:"RECEIVING_DISTRIBUTOR",rewardPoints:10,holdDays:7,monthlyCapPoints:1000,scope:{}},reason:"approved pilot reward policy"}});
  assert.equal(response.statusCode,201);
  assert.equal(response.json().rule.published_at,null);
  assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO audit_log")));
  assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO idempotency_records")));
  assert.equal(calls.find(call=>call.sql.startsWith("INSERT INTO campaigns")).params[0],tenantId);
});

test("claim release is tenant scoped, append-only, and idempotently paired with a ledger entry",async t=>{
  const calls=[],before={id:claimId,tenant_id:tenantId,status:"HELD",amount_points:25,beneficiary_organization_id:organizationId},after={...before,status:"AVAILABLE"},ledger={id:"66666666-6666-4666-8666-666666666666",entry_type:"RELEASE",amount_points:25};
  const client={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.includes("FROM idempotency_records"))return{rowCount:0,rows:[]};if(sql.startsWith("SELECT * FROM reward_claims"))return{rowCount:1,rows:[before]};if(sql.startsWith("UPDATE reward_claims"))return{rowCount:1,rows:[after]};if(sql.startsWith("INSERT INTO ledger_entries"))return{rowCount:1,rows:[ledger]};return{rowCount:1,rows:[]};}};
  const app=await buildApp({config,db:baseDb(client)});t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:`/api/v1/reward-claims/${claimId}/decisions`,headers:{...principal(),"idempotency-key":"claim-release-0001"},payload:{action:"RELEASE",reason:"receipt evidence approved by finance review"}});
  assert.equal(response.statusCode,200);
  assert.equal(response.json().claim.status,"AVAILABLE");
  const lock=calls.find(call=>call.sql.startsWith("SELECT * FROM reward_claims"));assert.deepEqual(lock.params,[tenantId,claimId]);assert.match(lock.sql,/FOR UPDATE/);
  const entry=calls.find(call=>call.sql.startsWith("INSERT INTO ledger_entries"));assert.equal(entry.params[3],"RELEASE");assert.equal(entry.params[4],25);assert.equal(entry.params[5],"claim-release-0001:ledger");
  assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO reward_claim_decisions")));
});

test("only settlement operators can reverse an available claim",async t=>{
  const app=await buildApp({config,db:baseDb({query:async()=>assert.fail("unauthorized request reached a transaction")})});t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:`/api/v1/reward-claims/${claimId}/decisions`,headers:{...principal("BRAND_ADMIN"),"idempotency-key":"claim-reverse-denied"},payload:{action:"REVERSE",reason:"post settlement correction with evidence"}});
  assert.equal(response.statusCode,403);assert.equal(response.json().code,"FORBIDDEN");
});

test("published campaign versions and claim decisions are database-immutable",async()=>{
  const sql=await readFile(new URL("../migrations/033_reward_governance.sql",import.meta.url),"utf8");
  assert.match(sql,/OLD\.published_at IS NOT NULL/);
  assert.match(sql,/campaign publication cannot alter rule fields/);
  assert.match(sql,/reward_claim_decisions_append_only/);
  assert.match(sql,/FORCE ROW LEVEL SECURITY/);
  assert.match(sql,/FOREIGN KEY \(tenant_id,claim_id\)/);
});

test("reward creation serializes campaign budget checks",async()=>{
  const source=await readFile(new URL("../src/routes.mjs",import.meta.url),"utf8");
  assert.match(source,/FROM campaigns c JOIN campaign_versions[\s\S]*FOR UPDATE OF c/);
});

test("reconciliation exports are asynchronous, tenant isolated, and object-storage backed",async()=>{
  const [migration,routes,worker,compose]=await Promise.all([
    readFile(new URL("../migrations/034_reward_reconciliation_exports.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/reward-routes.mjs",import.meta.url),"utf8"),
    readFile(new URL("../src/reward-reconciliation-worker.mjs",import.meta.url),"utf8"),
    readFile(new URL("../../../deploy/compose.production.yaml",import.meta.url),"utf8")
  ]);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/FOREIGN KEY \(tenant_id,beneficiary_organization_id\)/);
  assert.match(routes,/REWARD_RECONCILIATION_EXPORT_CREATE/);
  assert.match(routes,/presignRewardReconciliation/);
  assert.match(worker,/LIMIT 5000/);
  assert.match(worker,/ServerSideEncryption:"AES256"/);
  assert.match(compose,/reward-reconciliation-worker:/);
});
