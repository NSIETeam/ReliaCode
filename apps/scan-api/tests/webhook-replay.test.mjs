import assert from "node:assert/strict";
import test from "node:test";
import { reviewWebhookReplay } from "../src/webhook-routes.mjs";

test("webhook replay enforces a different approver",async()=>{const client={query:async()=>({rowCount:1,rows:[{id:"request-1",status:"PENDING",requested_by:"user-1",delivery_id:"delivery-1"}]})};await assert.rejects(()=>reviewWebhookReplay(client,{tenantId:"tenant-1",principalId:"user-1",id:"request-1",action:"APPROVE",reason:"reviewed"}),error=>error.code==="DUAL_CONTROL_REQUIRED");});

test("approved webhook replay resets only the tenant-scoped dead letter",async()=>{const calls=[],client={query:async(sql,params)=>{calls.push({sql,params});if(sql.startsWith("SELECT"))return{rowCount:1,rows:[{id:"request-1",status:"PENDING",requested_by:"user-1",delivery_id:"delivery-1"}]};if(sql.startsWith("UPDATE webhook_replay"))return{rowCount:1,rows:[{id:"request-1",status:"APPROVED"}]};return{rowCount:1,rows:[]};}};const result=await reviewWebhookReplay(client,{tenantId:"tenant-1",principalId:"user-2",id:"request-1",action:"APPROVE",reason:"evidence checked"});assert.equal(result.after.status,"APPROVED");assert.match(calls[2].sql,/WHERE tenant_id=\$1 AND id=\$2/);assert.deepEqual(calls[2].params,["tenant-1","delivery-1"]);});
