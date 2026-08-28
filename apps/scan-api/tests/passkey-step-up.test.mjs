import assert from "node:assert/strict";
import test from "node:test";
import { buildApp,hasFreshPasskeyVerification } from "../src/app.mjs";
import { hashToken } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";
import { createLocalSession } from "../src/session-security.mjs";

const now=Date.parse("2026-08-28T05:00:00.000Z");

test("sensitive operations accept only a recent Passkey verification",()=>{
  assert.equal(hasFreshPasskeyVerification({passkey_verified_at:"2026-08-28T04:55:00.000Z"},10,now),true);
  assert.equal(hasFreshPasskeyVerification({passkey_verified_at:"2026-08-28T04:49:59.999Z"},10,now),false);
  assert.equal(hasFreshPasskeyVerification({passkey_verified_at:"2026-08-28T05:00:00.001Z"},10,now),false);
  assert.equal(hasFreshPasskeyVerification({},10,now),false);
});

test("Passkey login marks the new session as freshly verified at the database boundary",async()=>{
  let insert;
  const db={transaction:async work=>work({query:async(sql,params=[])=>{
    if(sql.startsWith("SELECT ip_hash"))return{rowCount:0,rows:[]};
    if(sql.includes("INSERT INTO admin_sessions")){insert={sql,params};return{rowCount:1,rows:[]};}
    return{rowCount:1,rows:[]};
  }})};
  await createLocalSession(db,{SESSION_TTL_HOURS:24,SESSION_FINGERPRINT_KEY:Buffer.alloc(32,3).toString("base64url")},{userId:"11111111-1111-4111-8111-111111111111",tenantId:"22222222-2222-4222-8222-222222222222",request:{ip:"203.0.113.1",headers:{"user-agent":"Browser"}},authMethod:"PASSKEY"});
  assert.match(insert.sql,/passkey_verified_at/);
  assert.match(insert.sql,/CASE WHEN \$5='PASSKEY' THEN now\(\) END/);
  assert.equal(insert.params[4],"PASSKEY");
});

test("an administrator write is blocked until the current session completes Passkey step-up",async t=>{
  const token="session-token",csrf="csrf-token",userId="11111111-1111-4111-8111-111111111111",tenantId="22222222-2222-4222-8222-222222222222",organizationId="33333333-3333-4333-8333-333333333333";
  const config=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"local",ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000",SESSION_COOKIE_SECURE:"false",LOG_LEVEL:"silent"});
  const db={query:async sql=>{
    if(sql.includes("FROM admin_sessions WHERE token_hash"))return{rowCount:1,rows:[{token_hash:hashToken(token),csrf_token_hash:hashToken(csrf),user_id:userId,tenant_id:tenantId,passkey_verified_at:null}]};
    if(sql.includes("FROM local_users WHERE id"))return{rowCount:1,rows:[{id:userId,username:"owner",email:"owner@example.cn",tenant_id:tenantId,organization_id:organizationId,role:"TENANT_OWNER"}]};
    if(sql.includes("FROM local_memberships"))return{rowCount:1,rows:[{organization_id:organizationId,role:"TENANT_OWNER",organization_name:"Tenant"}]};
    if(sql.includes("count(*)::int count FROM webauthn_credentials"))return{rowCount:1,rows:[{count:2}]};
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const app=await buildApp({config,db});t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:"/api/v1/tenant/plan",headers:{cookie:`${config.SESSION_COOKIE_NAME}=${token}`,"x-csrf-token":csrf,"idempotency-key":"step-up-gate-test"},payload:{plan:"team",reason:"test gate"}});
  assert.equal(response.statusCode,428);
  assert.equal(response.json().code,"PASSKEY_STEP_UP_REQUIRED");
});
