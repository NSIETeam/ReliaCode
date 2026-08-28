import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";

const ids={tenant:"11111111-1111-4111-8111-111111111111",organization:"22222222-2222-4222-8222-222222222222",user:"44444444-4444-4444-8444-444444444444",document:"99999999-9999-4999-8999-999999999999",object:"77777777-7777-4777-8777-777777777777"};
const headers={"x-reliacode-principal":JSON.stringify({sub:ids.user,tenant_id:ids.tenant,organization_id:ids.organization,role:"BRAND_ADMIN"}),"idempotency-key":"document-command-route-0001"};
const config=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"development",CORS_ORIGINS:"http://localhost:4173",LOG_LEVEL:"silent"});

function database({expectedCount=0,documentStatus="DRAFT",version=0}={}){
  const calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.includes("FROM idempotency_records"))return{rowCount:0,rows:[]};
    if(sql.includes("SELECT * FROM business_documents"))return{rowCount:1,rows:[{id:ids.document,tenant_id:ids.tenant,status:documentStatus,version}]};
    if(sql.includes("count(*)::int count FROM business_document_objects"))return{rowCount:1,rows:[{count:expectedCount}]};
    if(sql.includes("DELETE FROM business_document_objects"))return{rowCount:1,rows:[{tenant_id:ids.tenant,document_id:ids.document,object_id:ids.object,expected:true}]};
    if(sql.includes("UPDATE business_documents"))return{rowCount:1,rows:[{id:ids.document,tenant_id:ids.tenant,status:"APPROVED",version:1}]};
    return{rowCount:1,rows:[{}]};
  }};
  return{calls,query:async(sql,params)=>{calls.push({sql,params});if(sql.includes("SELECT EXISTS"))return{rowCount:1,rows:[{active:true}]};return client.query(sql,params);},transaction:work=>work(client)};
}

test("an empty draft document cannot be approved",async t=>{
  const db=database(),app=await buildApp({config,db});t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:`/api/v1/documents/${ids.document}/transition`,headers,payload:{expectedVersion:0,status:"APPROVED",auditReason:"route approval gate"}});
  assert.equal(response.statusCode,409,response.body);
  assert.equal(response.json().code,"DOCUMENT_OBJECTS_REQUIRED");
  assert.equal(db.calls.some(call=>call.sql.includes("UPDATE business_documents")),false);
});

test("draft document object removal is tenant scoped and audited",async t=>{
  const db=database(),app=await buildApp({config,db});t.after(()=>app.close());
  const response=await app.inject({method:"DELETE",url:`/api/v1/documents/${ids.document}/objects/${ids.object}`,headers,payload:{auditReason:"remove incorrect line"}});
  assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json(),{removed:true,objectId:ids.object});
  const removal=db.calls.find(call=>call.sql.includes("DELETE FROM business_document_objects"));
  assert.deepEqual(removal.params,[ids.tenant,ids.document,ids.object]);
  assert.ok(db.calls.some(call=>call.sql.includes("INSERT INTO audit_log")));
});

test("a document with pending action objects cannot be completed",async t=>{
  const db=database({expectedCount:2,documentStatus:"IN_PROGRESS",version:3}),app=await buildApp({config,db});t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:`/api/v1/documents/${ids.document}/transition`,headers,payload:{expectedVersion:3,status:"COMPLETED",auditReason:"completion route gate"}});
  assert.equal(response.statusCode,409,response.body);
  assert.equal(response.json().code,"DOCUMENT_OBJECTS_PENDING");
  assert.equal(db.calls.some(call=>call.sql.includes("UPDATE business_documents")),false);
});

test("a field operator can list tenant documents needed for online work",async t=>{
  const db=database(),app=await buildApp({config,db});t.after(()=>app.close());
  const fieldHeaders={"x-reliacode-principal":JSON.stringify({sub:ids.user,tenant_id:ids.tenant,organization_id:ids.organization,role:"FACTORY_OPERATOR"})};
  const response=await app.inject({method:"GET",url:"/api/v1/documents",headers:fieldHeaders});
  assert.equal(response.statusCode,200,response.body);
  const query=db.calls.find(call=>call.sql.includes("FROM business_documents")&&call.sql.includes("ORDER BY created_at"));
  assert.deepEqual(query.params,[ids.tenant]);
});
