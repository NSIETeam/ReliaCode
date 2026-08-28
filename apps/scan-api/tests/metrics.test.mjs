import assert from "node:assert/strict";
import test from "node:test";
import { observeHttpRequest, renderMetrics } from "../src/metrics.mjs";

test("Prometheus output includes bounded route latency and operational queue gauges",async()=>{observeHttpRequest("GET","/api/v1/products",200,0.2);const db={query:async()=>({rowCount:1,rows:[{epcis_backlog:"2",epcis_dead_letters:"1",code_job_backlog:"3",code_export_backlog:"4",code_export_dead_letters:"1",webhook_backlog:"4",webhook_dead_letters:"5"}]})};const output=await renderMetrics(db);assert.match(output,/route="\/api\/v1\/products"/);assert.match(output,/reliacode_http_request_duration_seconds_bucket/);assert.match(output,/reliacode_epcis_dead_letters 1/);assert.match(output,/reliacode_code_job_backlog 3/);assert.match(output,/reliacode_code_export_backlog 4/);assert.match(output,/reliacode_code_export_dead_letters 1/);assert.match(output,/reliacode_webhook_dead_letters 5/);});
