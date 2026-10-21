import assert from "node:assert/strict";
import test from "node:test";
import { claimOutboxEvent, processOutboxEvent } from "../src/outbox-worker.mjs";

test("EPCIS claim excludes dead letters and uses skip-locked recovery",async()=>{const calls=[];const db={transaction:async(work)=>work({query:async(sql)=>{calls.push(sql);return sql.includes("SELECT *")?{rowCount:0,rows:[]}:{rowCount:1,rows:[]};}})};assert.equal(await claimOutboxEvent(db),null);assert.match(calls[0],/dead_lettered_at IS NULL/);assert.match(calls[0],/SKIP LOCKED/);});

test("tenth EPCIS failure is isolated as a dead letter",async()=>{let update;const db={query:async(sql,params)=>{update={sql,params};return{rowCount:1,rows:[]};}};const row={id:"outbox-1",attempts:9,payload:{event:{event_type:"PACKING",event_time:"2026-08-28T00:00:00Z",read_point:"factory",id:"event-1",organization_id:"org-1"},object:{code:"code-1"}}};await processOutboxEvent(db,{OPEN_EPCIS_BASE_URL:"https://epcis.example.cn",GS1_DIGITAL_LINK_BASE_URL:"https://id.reliacode.cn"},row,{fetchImpl:async()=>{throw new Error("offline");}});assert.match(update.sql,/dead_lettered_at=CASE WHEN attempts\+1>=10/);assert.equal(update.params[0],row.id);});
