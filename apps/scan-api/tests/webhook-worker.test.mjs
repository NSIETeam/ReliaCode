import assert from "node:assert/strict";
import test from "node:test";
import { claimWebhookDelivery,processWebhookDelivery } from "../src/webhook-worker.mjs";
import { encryptWebhookSecret,webhookSignature } from "../src/webhook-security.mjs";

const key=Buffer.alloc(32,19).toString("base64url");

test("webhook claim uses skip locked and stale lock recovery",async()=>{const calls=[];const db={transaction:async work=>work({query:async sql=>{calls.push(sql);return sql.includes("SELECT d.*")?{rowCount:0,rows:[]}:{rowCount:1,rows:[]};}})};assert.equal(await claimWebhookDelivery(db),null);assert.match(calls[0],/SKIP LOCKED/);assert.match(calls[0],/locked_at<now\(\)-interval '5 minutes'/);});

test("webhook delivery signs exact body and marks 2xx delivered",async()=>{const updates=[];const row={id:"delivery-1",tenant_id:"tenant-1",endpoint_id:"endpoint-1",event_type:"SHIPPING",url:"https://hooks.example.com/capture",encrypted_secret:encryptWebhookSecret("signing-secret",key),payload:{eventId:"event-1",object:{code:"01-code"}}};await processWebhookDelivery({query:async(sql,params)=>{updates.push({sql,params});return{rowCount:1,rows:[]};}},{WEBHOOK_ENCRYPTION_KEY:key},row,{lookup:async()=>[{address:"8.8.8.8"}],fetchImpl:async(url,options)=>{assert.equal(url.href,row.url);assert.equal(options.headers["x-reliacode-delivery"],row.id);assert.equal(options.headers["x-reliacode-signature"],webhookSignature("signing-secret",options.headers["x-reliacode-timestamp"],options.body));return{status:204};}});assert.match(updates[0].sql,/status='DELIVERED'/);});

test("tenth webhook failure is dead-lettered",async()=>{let update;const row={id:"delivery-2",tenant_id:"tenant-1",endpoint_id:"endpoint-1",event_type:"SHIPPING",url:"https://hooks.example.com/capture",encrypted_secret:encryptWebhookSecret("secret",key),payload:{},attempts:9};await processWebhookDelivery({query:async(sql,params)=>{update={sql,params};return{rowCount:1,rows:[]};}},{WEBHOOK_ENCRYPTION_KEY:key},row,{lookup:async()=>[{address:"8.8.8.8"}],fetchImpl:async()=>{throw new Error("offline");}});assert.match(update.sql,/status=CASE WHEN attempts\+1>=10 THEN 'DEAD_LETTER'/);assert.equal(update.params[0],row.id);});
