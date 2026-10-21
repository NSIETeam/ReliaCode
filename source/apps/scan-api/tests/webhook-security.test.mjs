import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeWebhookUrl,decryptWebhookSecret,encryptWebhookSecret,webhookSignature } from "../src/webhook-security.mjs";

const key=Buffer.alloc(32,11).toString("base64url");

test("webhook secrets are encrypted with authenticated encryption",()=>{const encrypted=encryptWebhookSecret("secret-value",key);assert.notEqual(encrypted,"secret-value");assert.equal(decryptWebhookSecret(encrypted,key),"secret-value");assert.throws(()=>decryptWebhookSecret(encrypted,Buffer.alloc(32,12).toString("base64url")));});

test("webhook signatures bind timestamp and exact body",()=>{assert.equal(webhookSignature("secret","1724800000",'{"ok":true}'),webhookSignature("secret","1724800000",'{"ok":true}'));assert.notEqual(webhookSignature("secret","1724800000",'{"ok":true}'),webhookSignature("secret","1724800001",'{"ok":true}'));});

test("webhook URL validation rejects local, private, reserved, and DNS failure targets",async()=>{for(const value of ["http://example.com/hook","https://localhost/hook","https://127.0.0.1/hook","https://10.0.0.1/hook","https://100.64.0.1/hook","https://192.0.2.1/hook","https://[::1]/hook"]){await assert.rejects(()=>assertSafeWebhookUrl(value),error=>error.code==="WEBHOOK_URL_UNSAFE");}await assert.rejects(()=>assertSafeWebhookUrl("https://missing.example/hook",{lookup:async()=>{throw new Error("NXDOMAIN");}}),error=>error.code==="WEBHOOK_URL_UNSAFE");});

test("webhook URL validation accepts only when every DNS answer is public",async()=>{const url=await assertSafeWebhookUrl("https://hooks.example.com/capture",{lookup:async()=>[{address:"8.8.8.8"},{address:"1.1.1.1"}]});assert.equal(url.href,"https://hooks.example.com/capture");await assert.rejects(()=>assertSafeWebhookUrl("https://hooks.example.com/capture",{lookup:async()=>[{address:"8.8.8.8"},{address:"192.168.1.2"}]}),error=>error.code==="WEBHOOK_URL_UNSAFE");});
