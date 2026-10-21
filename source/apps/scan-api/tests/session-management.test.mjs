import assert from "node:assert/strict";
import test from "node:test";
import { revokeOtherSessions,revokeSession } from "../src/passkey-routes.mjs";

const context={sessionId:"44444444-4444-4444-8444-444444444444",userId:"11111111-1111-4111-8111-111111111111",tenantId:"22222222-2222-4222-8222-222222222222"};

test("single-device logout is tenant and user scoped and emits one authentication event",async()=>{
  const calls=[],client={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.startsWith("UPDATE admin_sessions"))return{rowCount:1,rows:[{id:context.sessionId}]};return{rowCount:1,rows:[]};}};
  assert.equal(await revokeSession(client,context),true);
  const update=calls.find(call=>call.sql.startsWith("UPDATE admin_sessions"));
  assert.deepEqual(update.params.slice(0,3),[context.userId,context.sessionId,context.tenantId]);
  assert.match(update.sql,/user_id=\$1 AND tenant_id=\$3/);
  assert.equal(calls.filter(call=>call.sql.includes("INSERT INTO authentication_events")).length,1);
});

test("repeating an already-revoked device logout is successful without a second event",async()=>{
  const calls=[],client={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.startsWith("UPDATE admin_sessions"))return{rowCount:0,rows:[]};if(sql.startsWith("SELECT 1 FROM admin_sessions"))return{rowCount:1,rows:[{"?column?":1}]};throw new Error(`Unexpected SQL: ${sql}`);}};
  assert.equal(await revokeSession(client,context),true);
  assert.equal(calls.some(call=>call.sql.includes("INSERT INTO authentication_events")),false);
});

test("logout-all-others preserves the current token and stays inside the tenant",async()=>{
  const calls=[],client={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.startsWith("UPDATE admin_sessions"))return{rowCount:3,rows:[]};return{rowCount:1,rows:[]};}},currentTokenHash="current-token-hash",reason="lost laptop";
  assert.equal(await revokeOtherSessions(client,{userId:context.userId,tenantId:context.tenantId,currentTokenHash,reason}),3);
  const update=calls[0];
  assert.deepEqual(update.params,[context.userId,context.tenantId,currentTokenHash,reason]);
  assert.match(update.sql,/tenant_id=\$2 AND token_hash<>\$3/);
  const event=calls.find(call=>call.sql.includes("INSERT INTO authentication_events"));
  assert.deepEqual(event.params[3],{count:3,scope:"OTHER_SESSIONS"});
});
