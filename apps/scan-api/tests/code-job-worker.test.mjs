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

test("code worker resumes an existing batch and completes only after persisted rows reach quantity",async()=>{
  const updates=[];const job={id:"job-2",tenant_id:"tenant-1",product_id:"product-1",code_batch_id:"batch-1",requested_by:"user-1",level:"ITEM",quantity:5,serial_rule:"SEQUENTIAL",lot:"LOT-1",generated_count:3,gtin:"06912345678902"};
  const db=database(async(sql,params=[])=>{if(sql.includes("SELECT j.*"))return{rowCount:1,rows:[job]};if(sql.includes("INSERT INTO serialized_objects"))return{rowCount:2,rows:[{id:"one"},{id:"two"}]};if(sql.includes("UPDATE code_generation_jobs SET generated_count")){updates.push(params);return{rowCount:1,rows:[]};}throw new Error(`Unexpected SQL: ${sql}`);});
  assert.equal(await processCodeJobChunk(db,{GS1_DIGITAL_LINK_BASE_URL:"https://id.reliacode.cn"}),true);
  assert.equal(updates[0][1],5);
});
