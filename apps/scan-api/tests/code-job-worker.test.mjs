import assert from "node:assert/strict";
import test from "node:test";
import { processCodeJobChunk } from "../src/code-job-worker.mjs";

function database(handler){return{transaction:async(work)=>work({query:handler})};}

test("code worker fails safely instead of emitting placeholder identifiers without a GTIN",async()=>{
  const calls=[];const db=database(async(sql,params=[])=>{calls.push({sql,params});if(sql.includes("SELECT j.*"))return{rowCount:1,rows:[{id:"job-1",tenant_id:"tenant-1",quantity:10,generated_count:0,gtin:null}]};if(sql.includes("status='FAILED'")||sql.includes("UPDATE tenant_usage_monthly"))return{rowCount:1,rows:[]};throw new Error(`Unexpected SQL: ${sql}`);});
  assert.equal(await processCodeJobChunk(db,{GS1_DIGITAL_LINK_BASE_URL:"https://id.example.cn"}),true);
  assert.ok(calls.some(call=>call.sql.includes("status='FAILED'")));
  assert.equal(calls.some(call=>call.sql.includes("INSERT INTO serialized_objects")),false);
});

test("code worker resumes an existing batch, pads GTIN for Digital Link, and completes only after persisted rows reach quantity",async()=>{
  const updates=[],inserts=[];const job={id:"job-2",tenant_id:"tenant-1",product_id:"product-1",code_batch_id:"batch-1",requested_by:"user-1",level:"ITEM",quantity:5,serial_rule:"SEQUENTIAL",lot:"LOT-1",generated_count:3,gtin:"12345670"};
  const db=database(async(sql,params=[])=>{if(sql.includes("SELECT j.*"))return{rowCount:1,rows:[job]};if(sql.includes("INSERT INTO serialized_objects")){inserts.push(params);return{rowCount:2,rows:[{id:"one"},{id:"two"}]};}if(sql.includes("UPDATE code_generation_jobs SET generated_count")){updates.push(params);return{rowCount:1,rows:[]};}throw new Error(`Unexpected SQL: ${sql}`);});
  assert.equal(await processCodeJobChunk(db,{GS1_DIGITAL_LINK_BASE_URL:"https://id.reliacode.cn"}),true);
  assert.equal(inserts[0][4],"00000012345670");
  assert.equal(updates[0][1],5);
});

test("SGTIN places an encoded AI (10) lot before AI (21) serial",async()=>{
  let insert;const job={id:"job-lot",tenant_id:"tenant-1",product_id:"product-1",code_batch_id:"batch-1",requested_by:"user-1",level:"ITEM",identifier_scheme:"SGTIN",quantity:1,serial_rule:"SEQUENTIAL",lot:"Lot/a+b",generated_count:0,gtin:"06912345678902"};
  const db=database(async(sql,params=[])=>{if(sql.includes("SELECT j.*"))return{rowCount:1,rows:[job]};if(sql.includes("INSERT INTO serialized_objects")){insert={sql,params};return{rowCount:1,rows:[{id:"one"}]};}if(sql.includes("UPDATE code_generation_jobs SET generated_count"))return{rowCount:1,rows:[]};throw new Error(`Unexpected SQL: ${sql}`);});
  await processCodeJobChunk(db,{GS1_DIGITAL_LINK_BASE_URL:"https://id.reliacode.cn"});
  assert.match(insert.sql,/\/10\/.*\/21\//);
  assert.equal(insert.params[10],"Lot%2Fa%2Bb");
});

test("worker query selects the GTIN for the job packaging level",async()=>{
  let selection;const db=database(async(sql)=>{selection=sql;return{rowCount:0,rows:[]};});
  assert.equal(await processCodeJobChunk(db,{GS1_DIGITAL_LINK_BASE_URL:"https://id.reliacode.cn"}),false);
  assert.match(selection,/product_trade_items/);
  assert.match(selection,/pi\.level=j\.level/);
  assert.match(selection,/WHEN j\.level='ITEM'/);
});

test("pallet worker emits SSCC AI (00) from the immutable allocation snapshot without requiring a GTIN",async()=>{
  let insert;const job={id:"job-sscc",tenant_id:"tenant-1",product_id:"product-1",code_batch_id:"batch-1",requested_by:"user-1",level:"PALLET",identifier_scheme:"SSCC",quantity:2,serial_rule:"SEQUENTIAL",lot:"LOT-1",generated_count:0,gtin:null,gs1_company_prefix_snapshot:"0614141",sscc_extension_digit:0,sscc_start_reference:"12345"};
  const db=database(async(sql,params=[])=>{if(sql.includes("SELECT j.*"))return{rowCount:1,rows:[job]};if(sql.includes("INSERT INTO serialized_objects")){insert={sql,params};return{rowCount:2,rows:[{id:"one"},{id:"two"}]};}if(sql.includes("UPDATE code_generation_jobs SET generated_count"))return{rowCount:1,rows:[]};throw new Error(`Unexpected SQL: ${sql}`);});
  assert.equal(await processCodeJobChunk(db,{GS1_DIGITAL_LINK_BASE_URL:"https://id.reliacode.cn"}),true);
  assert.match(insert.sql,/\/00\/.*gs1_sscc/);
  assert.deepEqual(insert.params.slice(4,8),["0614141",0,"12345",0]);
});

test("legacy pallet jobs fail closed and release their unused quota",async()=>{
  const calls=[],job={id:"legacy",tenant_id:"tenant-1",quantity:10,generated_count:0,identifier_scheme:"LEGACY_NONCONFORMING",gtin:"06912345678902"};
  const db=database(async(sql,params=[])=>{calls.push({sql,params});if(sql.includes("SELECT j.*"))return{rowCount:1,rows:[job]};return{rowCount:1,rows:[]};});
  assert.equal(await processCodeJobChunk(db,{GS1_DIGITAL_LINK_BASE_URL:"https://id.reliacode.cn"}),true);
  assert.match(calls.find(call=>call.sql.includes("status='FAILED'")).params[1],/nonconforming/);
  assert.equal(calls.some(call=>call.sql.includes("INSERT INTO serialized_objects")),false);
});
