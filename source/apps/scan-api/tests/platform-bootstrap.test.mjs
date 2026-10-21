import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapPlatformOperator, configurePlatformBootstrapContext } from '../src/bootstrap-platform-operator.mjs';

const input={username:'platform_owner',email:'platform@example.cn',password:'Strong-Bootstrap-2026!',tenantId:'00000000-0000-4000-8000-000000000001',organizationId:'00000000-0000-4000-8000-000000000002'};

test('platform bootstrap enables system RLS access only in its current transaction', async () => {
  const calls=[];
  await configurePlatformBootstrapContext({query:async(sql)=>{calls.push(sql);return{rowCount:1,rows:[]};}});
  assert.deepEqual(calls,["SELECT set_config('reliacode.tenant_id','',true),set_config('reliacode.system_access','on',true)"]);
});

test('platform bootstrap creates a real single-use audited operator without persisting plaintext', async () => {
  const calls=[];
  const client={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.includes("WHERE role='PLATFORM_OPERATOR'"))return{rowCount:0,rows:[]};if(sql.startsWith('SELECT id FROM tenants'))return{rowCount:1,rows:[{id:input.tenantId}]};if(sql.startsWith('SELECT id FROM organizations'))return{rowCount:1,rows:[{id:input.organizationId}]};if(sql.includes('INSERT INTO local_users'))return{rowCount:1,rows:[{id:'10000000-0000-4000-8000-000000000001',username:input.username,email:input.email,role:'PLATFORM_OPERATOR'}]};return{rowCount:1,rows:[]};}};
  const user=await bootstrapPlatformOperator(client,input);
  assert.equal(user.role,'PLATFORM_OPERATOR');
  const userInsert=calls.find(call=>call.sql.includes('INSERT INTO local_users'));
  assert.match(userInsert.params[5],/^scrypt\$/);
  assert.equal(userInsert.params.includes(input.password),false);
  assert.ok(calls.some(call=>call.sql.includes('PLATFORM_OPERATOR_BOOTSTRAPPED')));
  assert.ok(calls.some(call=>call.sql.includes("local_memberships")&&call.sql.includes("'PLATFORM_OPERATOR'")));
});

test('platform bootstrap refuses to create a second active operator', async () => {
  const client={query:async(sql)=>sql.includes("WHERE role='PLATFORM_OPERATOR'")?{rowCount:1,rows:[{id:'existing'}]}:{rowCount:1,rows:[]}};
  await assert.rejects(()=>bootstrapPlatformOperator(client,input),/single-use/);
});
