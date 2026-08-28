import assert from "node:assert/strict";
import test from "node:test";
import { issueRecoveryCodes,revokePasskey } from "../src/passkey-routes.mjs";
import { requestHash } from "../src/idempotency.mjs";

const context={id:"credential-lost-device",userId:"11111111-1111-4111-8111-111111111111",tenantId:"22222222-2222-4222-8222-222222222222",organizationId:"33333333-3333-4333-8333-333333333333",role:"TENANT_OWNER",requestId:"request-1",idempotencyKey:"passkey-revoke-0001"};

test("an administrator cannot revoke a Passkey below the two-credential minimum",async()=>{
  const client={query:async sql=>{
    if(sql.startsWith("SELECT id FROM webauthn_credentials"))return{rowCount:2,rows:[{id:context.id},{id:"credential-backup"}]};
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  await assert.rejects(()=>revokePasskey(client,context),error=>error.code==="PASSKEY_MINIMUM_REQUIRED"&&error.statusCode===409);
});

test("Passkey revocation is user-scoped, audited, and retry safe",async()=>{
  const calls=[],client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.startsWith("SELECT id FROM webauthn_credentials"))return{rowCount:3,rows:[{id:context.id},{id:"credential-backup"},{id:"credential-third"}]};
    return{rowCount:1,rows:[]};
  }};
  assert.equal(await revokePasskey(client,context),true);
  const deletion=calls.find(call=>call.sql.startsWith("DELETE FROM webauthn_credentials"));
  assert.deepEqual(deletion.params,[context.id,context.userId]);
  const audit=calls.find(call=>call.sql.includes("INSERT INTO audit_log"));
  assert.equal(audit.params[6].idempotencyKey,context.idempotencyKey);
  assert.equal(audit.params[6].remaining,2);

  const retry={query:async sql=>sql.startsWith("SELECT id FROM webauthn_credentials")?{rowCount:2,rows:[{id:"credential-backup"},{id:"credential-third"}]}:assert.fail(`Unexpected SQL on retry: ${sql}`)};
  assert.equal(await revokePasskey(retry,context),false);
});

test("repeating a recovery-code idempotency key never generates a second batch",async()=>{
  const issuance={...context,reason:"lost recovery sheet"},calls=[],client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.startsWith("SELECT request_hash"))return{rowCount:1,rows:[{request_hash:requestHash("RECOVERY_CODES_ROTATE",{reason:issuance.reason})}]};
    return{rowCount:1,rows:[]};
  }};
  const result=await issueRecoveryCodes(client,issuance);
  assert.deepEqual(result,{duplicate:true,codes:[]});
  assert.equal(calls.some(call=>call.sql.startsWith("DELETE FROM account_recovery_codes")),false);
  assert.equal(calls.some(call=>call.sql.startsWith("INSERT INTO account_recovery_codes")),false);
});

test("first recovery-code issuance stores only hashes and its idempotency record",async()=>{
  const issuance={...context,reason:"initial offline recovery set"},calls=[],client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.startsWith("SELECT request_hash"))return{rowCount:0,rows:[]};
    return{rowCount:1,rows:[]};
  }};
  const result=await issueRecoveryCodes(client,issuance);
  assert.equal(result.duplicate,false);
  assert.equal(result.codes.length,10);
  const codeWrites=calls.filter(call=>call.sql.startsWith("INSERT INTO account_recovery_codes"));
  assert.equal(codeWrites.length,10);
  assert.equal(codeWrites.some(call=>result.codes.includes(call.params[1])),false);
  assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO recovery_code_issuances")));
});
