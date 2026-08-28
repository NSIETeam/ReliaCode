import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";

const ids={tenant:"11111111-1111-4111-8111-111111111111",organization:"22222222-2222-4222-8222-222222222222",destination:"33333333-3333-4333-8333-333333333333",user:"44444444-4444-4444-8444-444444444444",device:"55555555-5555-4555-8555-555555555555",location:"66666666-6666-4666-8666-666666666666",object:"77777777-7777-4777-8777-777777777777",product:"88888888-8888-4888-8888-888888888888",document:"99999999-9999-4999-8999-999999999999",event:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
const principal=JSON.stringify({sub:ids.user,tenant_id:ids.tenant,organization_id:ids.organization,role:"BRAND_ADMIN",name:"Route Test"});
const deviceToken="route-test-device-token-0123456789abcdef";
const config=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"development",CORS_ORIGINS:"http://localhost:4173",LOG_LEVEL:"silent",REQUIRE_DEVICE_AUTHORIZATION:"true"});

function database({documentObject=true}={}){
  const calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.includes("FROM idempotency_records"))return{rowCount:0,rows:[]};
    if(sql.includes("FROM devices d"))return{rowCount:1,rows:[{id:ids.device,location_id:ids.location,gln:"6901234567892"}]};
    if(sql.includes("FROM serialized_objects so JOIN products"))return{rowCount:1,rows:[{id:ids.object,tenant_id:ids.tenant,product_id:ids.product,code:"010691234567890210LOT-A21SERIAL-1",level:"ITEM",status:"COMMISSIONED",parent_id:null,current_organization_id:ids.organization,sku:"SKU-1",gtin:"06912345678902",product_name:"Test product"}]};
    if(sql.includes("FROM business_documents"))return{rowCount:1,rows:[{id:ids.document,tenant_id:ids.tenant,document_type:"SHIPMENT",status:"APPROVED",from_organization_id:ids.organization,to_organization_id:ids.destination}]};
    if(sql.includes("FROM business_document_objects"))return documentObject?{rowCount:1,rows:[{expected:true,object_snapshot:{id:ids.object}}]}:{rowCount:0,rows:[]};
    if(sql.includes("INSERT INTO trace_events"))return{rowCount:1,rows:[{id:ids.event,event_type:"SHIPPING",event_time:"2026-08-28T09:00:00.000Z",verification_status:"VERIFIED"}]};
    return{rowCount:1,rows:[{}]};
  }};
  return{calls,query:async(sql,params)=>{calls.push({sql,params});if(sql.includes("SELECT EXISTS"))return{rowCount:1,rows:[{active:true}]};return client.query(sql,params);},transaction:work=>work(client)};
}

function request(){return{method:"POST",url:"/api/v1/trace-events",headers:{"x-reliacode-principal":principal,"x-reliacode-device-id":ids.device,"x-reliacode-device-token":deviceToken,"idempotency-key":"trace-route-shipping-0001"},payload:{eventType:"SHIPPING",objectCode:"010691234567890210LOT-A21SERIAL-1",documentId:ids.document,readPoint:"urn:ignored:when-device-is-required",eventTime:"2026-08-28T09:00:00.000Z",metadata:{source:"route-test"}}};}

test("state-changing trace route authorizes the device and enforces document membership",async t=>{
  const db=database(),app=await buildApp({config,db});t.after(()=>app.close());
  const response=await app.inject(request());
  assert.equal(response.statusCode,201,response.body);
  assert.equal(response.json().object.status,"IN_TRANSIT");
  assert.equal(response.json().stateApplied,true);
  const deviceCall=db.calls.find(call=>call.sql.includes("FROM devices d"));
  const membershipCall=db.calls.find(call=>call.sql.includes("FROM business_document_objects"));
  const eventCall=db.calls.find(call=>call.sql.includes("INSERT INTO trace_events"));
  assert.ok(deviceCall,"device authorization query must run");
  assert.deepEqual(membershipCall.params,[ids.tenant,ids.document,ids.object]);
  assert.equal(eventCall.params[8],ids.device);
  assert.equal(eventCall.params[9],ids.location);
  assert.equal(eventCall.params[11],"https://id.gs1.org/414/6901234567892");
  assert.ok(db.calls.indexOf(deviceCall)<db.calls.indexOf(eventCall));
});

test("trace route rejects an object that is absent from the approved document",async t=>{
  const db=database({documentObject:false}),app=await buildApp({config,db});t.after(()=>app.close());
  const response=await app.inject(request());
  assert.equal(response.statusCode,409,response.body);
  assert.equal(response.json().code,"OBJECT_NOT_ON_DOCUMENT");
  assert.equal(db.calls.some(call=>call.sql.includes("INSERT INTO trace_events")),false);
});
