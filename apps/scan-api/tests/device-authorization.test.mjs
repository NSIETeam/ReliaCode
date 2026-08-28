import assert from "node:assert/strict";
import test from "node:test";
import { hashToken } from "../src/auth.mjs";
import { authorizeOperationalDevice } from "../src/device-authorization.mjs";
import { buildApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";

const deviceId="11111111-1111-4111-8111-111111111111",tenantId="22222222-2222-4222-8222-222222222222",organizationId="33333333-3333-4333-8333-333333333333",locationId="44444444-4444-4444-8444-444444444444",token="d".repeat(43);
const request={headers:{"x-reliacode-device-id":deviceId,"x-reliacode-device-token":token},principal:{tenantId,organizationId}};

test("development can explicitly disable device authorization",async()=>{
  const result=await authorizeOperationalDevice({query:async()=>assert.fail("database should not be queried")},{REQUIRE_DEVICE_AUTHORIZATION:false},request,"SHIPPING",{fallbackReadPoint:"test-read-point"});
  assert.deepEqual(result,{deviceId:null,locationId:null,readPoint:"test-read-point"});
});

test("an active device is bound to its tenant, organization, event type, and GLN",async()=>{
  const calls=[],client={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.includes("FROM devices d"))return{rowCount:1,rows:[{id:deviceId,location_id:locationId,gln:"6901234567892"}]};return{rowCount:1,rows:[]};}};
  const result=await authorizeOperationalDevice(client,{REQUIRE_DEVICE_AUTHORIZATION:true},request,"SHIPPING",{fallbackReadPoint:"untrusted"});
  assert.deepEqual(result,{deviceId,locationId,readPoint:"https://id.gs1.org/414/6901234567892"});
  assert.deepEqual(calls[0].params,[deviceId,tenantId,organizationId,hashToken(token),"SHIPPING"]);
  assert.match(calls[0].sql,/d\.status='ACTIVE'/);
  assert.match(calls[0].sql,/ANY\(d\.allowed_event_types\)/);
  assert.deepEqual(calls[1].params,[tenantId,deviceId]);
});

test("unknown, revoked, wrong-tenant, and unauthorized-event devices share one response",async()=>{
  const client={query:async()=>({rowCount:0,rows:[]})};
  await assert.rejects(()=>authorizeOperationalDevice(client,{REQUIRE_DEVICE_AUTHORIZATION:true},request,"DESTROYING"),error=>error.code==="DEVICE_NOT_AUTHORIZED"&&error.statusCode===404);
});

test("production rejects locations without a GLN",async()=>{
  const client={query:async()=>({rowCount:1,rows:[{id:deviceId,location_id:locationId,gln:null}]})};
  await assert.rejects(()=>authorizeOperationalDevice(client,{REQUIRE_DEVICE_AUTHORIZATION:true},request,"SHIPPING"),error=>error.code==="DEVICE_LOCATION_GLN_REQUIRED"&&error.statusCode===409);
});

test("production rejects a location whose GLN check digit is invalid",async()=>{
  const client={query:async()=>({rowCount:1,rows:[{id:deviceId,location_id:locationId,gln:"6901234567891"}]})};
  await assert.rejects(()=>authorizeOperationalDevice(client,{REQUIRE_DEVICE_AUTHORIZATION:true},request,"SHIPPING"),error=>error.code==="DEVICE_LOCATION_GLN_REQUIRED"&&error.statusCode===409);
});

test("device inventory never selects or returns credential hashes",async t=>{
  let inventorySql;
  const db={query:async sql=>{if(sql.includes("SELECT EXISTS"))return{rowCount:1,rows:[{active:true}]};if(sql.includes("FROM devices WHERE tenant_id")){inventorySql=sql;return{rowCount:1,rows:[{id:deviceId,name:"Scanner"}]};}throw new Error(`Unexpected SQL: ${sql}`);}},config=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"development",LOG_LEVEL:"silent"}),app=await buildApp({config,db});t.after(()=>app.close());
  const principal=JSON.stringify({sub:"admin",tenant_id:tenantId,organization_id:organizationId,role:"BRAND_ADMIN"}),response=await app.inject({method:"GET",url:"/api/v1/devices",headers:{"x-reliacode-principal":principal}});
  assert.equal(response.statusCode,200);
  assert.doesNotMatch(inventorySql,/credential_hash/);
  assert.equal(response.json().items[0].credential_hash,undefined);
});

test("device registration returns its credential once and persists only a hash",async t=>{
  const calls=[],client={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.includes("FROM idempotency_records"))return{rowCount:0,rows:[]};if(sql.startsWith("SELECT gln FROM locations"))return{rowCount:1,rows:[{gln:"6901234567892"}]};if(sql.includes("INSERT INTO devices"))return{rowCount:1,rows:[{id:deviceId,tenant_id:tenantId,organization_id:organizationId,location_id:locationId,name:"Scanner",allowed_event_types:["SHIPPING"],status:"ACTIVE"}]};return{rowCount:1,rows:[]};}},db={query:async sql=>sql.includes("SELECT EXISTS")?{rowCount:1,rows:[{active:true}]}:{rowCount:0,rows:[]},transaction:async work=>work(client)},config=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"development",LOG_LEVEL:"silent"}),app=await buildApp({config,db});t.after(()=>app.close());
  const principal=JSON.stringify({sub:"admin",tenant_id:tenantId,organization_id:organizationId,role:"BRAND_ADMIN"}),response=await app.inject({method:"POST",url:"/api/v1/devices",headers:{"x-reliacode-principal":principal,"idempotency-key":"device-register-test-0001"},payload:{organizationId,locationId,name:"Scanner",allowedEventTypes:["SHIPPING"],auditReason:"register production scanner"}});
  assert.equal(response.statusCode,201);
  const body=response.json();assert.ok(body.deviceToken.length>=43);assert.equal(body.credentialPreviouslyIssued,false);
  const insert=calls.find(call=>call.sql.includes("INSERT INTO devices"));assert.equal(insert.params[5],hashToken(body.deviceToken));assert.equal(insert.params.includes(body.deviceToken),false);
  const idempotency=calls.find(call=>call.sql.includes("INSERT INTO idempotency_records"));assert.equal(idempotency.params[5].deviceToken,null);assert.equal(JSON.stringify(idempotency.params).includes(body.deviceToken),false);
});
