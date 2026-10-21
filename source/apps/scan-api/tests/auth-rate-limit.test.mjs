import assert from "node:assert/strict";
import test from "node:test";
import { authRateLimitKey,authenticationBlocked,clearAuthenticationFailures,consumeSharedAuthenticationQuota,recordAuthenticationFailure } from "../src/auth-rate-limit.mjs";

function sharedDatabase() {
  const rows=new Map();
  const query=async(sql,params=[])=>{
    const key=params[0],row=rows.get(key);
    if(sql.includes("WHERE key_hash IN")){for(const [candidate,value] of rows)if(value.expires_at<=Date.now())rows.delete(candidate);return{rowCount:0,rows:[]};}
    if(sql.includes("pg_advisory_xact_lock"))return{rowCount:1,rows:[{}]};
    if(sql.includes("clock_timestamp()"))return{rowCount:1,rows:[{database_now:new Date()}]};
    if(sql.includes("blocked_until>now()"))return row&&row.expires_at>Date.now()?{rowCount:1,rows:[{blocked:row.blocked_until>Date.now()}]}:{rowCount:0,rows:[]};
    if(sql.includes("FOR UPDATE"))return row?{rowCount:1,rows:[{failure_count:row.failure_count,window_started_at:new Date(row.window_started_at),blocked_until:row.blocked_until?new Date(row.blocked_until):null}]}:{rowCount:0,rows:[]};
    if(sql.includes("INSERT INTO authentication_rate_limits")){rows.set(key,{failure_count:params[1],window_started_at:Date.now(),blocked_until:params[2]?.getTime()||0,expires_at:params[3].getTime()});return{rowCount:1,rows:[]};}
    if(sql.includes("UPDATE authentication_rate_limits")){rows.set(key,{failure_count:params[1],window_started_at:params[2]?Date.now():row.window_started_at,blocked_until:params[3]?.getTime()||0,expires_at:params[4].getTime()});return{rowCount:1,rows:[]};}
    if(sql.includes("DELETE FROM authentication_rate_limits")){rows.delete(key);return{rowCount:1,rows:[]};}
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return{rows,query,transaction:async work=>work({query})};
}

test("rate-limit identities are deterministic opaque HMAC values",()=>{
  const secret="test-secret",first=authRateLimitKey(secret,"login","203.0.113.1","Owner@Example.cn");
  assert.match(first,/^[0-9a-f]{64}$/);
  assert.equal(first,authRateLimitKey(secret,"login","203.0.113.1","owner@example.cn"));
  assert.doesNotMatch(first,/owner|203/);
  assert.notEqual(first,authRateLimitKey(secret,"login","203.0.113.2","owner@example.cn"));
});

test("network and account dimensions cannot be bypassed by rotating only one input",()=>{
  const secret="test-secret";
  const networkA=authRateLimitKey(secret,"login-network","203.0.113.1");
  const networkB=authRateLimitKey(secret,"login-network","203.0.113.2");
  const identityA=authRateLimitKey(secret,"login-identity","owner@example.cn");
  const identityB=authRateLimitKey(secret,"login-identity","operator@example.cn");
  assert.notEqual(networkA,networkB);
  assert.notEqual(identityA,identityB);
  assert.notEqual(networkA,identityA);
});

test("separate API instances share failure state and block at the fifth failure",async()=>{
  const db=sharedDatabase(),key=authRateLimitKey("secret","login","198.51.100.4","user");
  const instanceA={query:db.query,transaction:db.transaction},instanceB={query:db.query,transaction:db.transaction};
  for(let count=1;count<=4;count+=1){const result=await recordAuthenticationFailure(count%2?instanceA:instanceB,key);assert.equal(result.count,count);assert.equal(result.blocked,false);}
  assert.equal(await authenticationBlocked(instanceB,key),false);
  const fifth=await recordAuthenticationFailure(instanceA,key);
  assert.equal(fifth.blocked,true);
  assert.equal(await authenticationBlocked(instanceB,key),true);
  await clearAuthenticationFailures(instanceB,key);
  assert.equal(await authenticationBlocked(instanceA,key),false);
});

test("database migration protects rate-limit state with trusted-system RLS",async()=>{
  const {readFile}=await import("node:fs/promises");
  const sql=await readFile(new URL("../migrations/032_database_authentication_rate_limits.sql",import.meta.url),"utf8");
  assert.match(sql,/FORCE ROW LEVEL SECURITY/);
  assert.match(sql,/reliacode_system_access\(\)/);
  assert.doesNotMatch(sql,/username|ip_address/i);
});

test("failure recording locks absent keys and uses the database clock",async()=>{
  const calls=[],db={transaction:async work=>work({query:async(sql)=>{calls.push(sql);if(sql.includes("clock_timestamp()"))return{rows:[{database_now:new Date()}]};if(sql.includes("FOR UPDATE"))return{rows:[]};return{rows:[],rowCount:1};}})};
  await recordAuthenticationFailure(db,"a".repeat(64));
  assert.ok(calls.some(sql=>sql.includes("pg_advisory_xact_lock")));
  assert.ok(calls.some(sql=>sql.includes("clock_timestamp()")));
  assert.ok(calls.findIndex(sql=>sql.includes("pg_advisory_xact_lock"))<calls.findIndex(sql=>sql.includes("FOR UPDATE")));
});

test("shared anonymous quotas allow the configured volume and block the next request",async()=>{
  const db=sharedDatabase(),secret="shared-secret";
  for(let index=0;index<3;index+=1){
    const quota=await consumeSharedAuthenticationQuota(db,secret,"passkey-verify","203.0.113.20",{maxRequests:3,windowMs:300_000});
    assert.equal(quota.allowed,true);
  }
  const blocked=await consumeSharedAuthenticationQuota(db,secret,"passkey-verify","203.0.113.20",{maxRequests:3,windowMs:300_000});
  assert.equal(blocked.allowed,false);
  const otherRoute=await consumeSharedAuthenticationQuota(db,secret,"recovery-code","203.0.113.20",{maxRequests:3,windowMs:300_000});
  assert.equal(otherRoute.allowed,true);
});
