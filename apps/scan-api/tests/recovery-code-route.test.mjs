import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.mjs";
import { hashPassword,hashToken } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";

test("a recovery code is atomically consumed and never sent to storage in plaintext",async(t)=>{let matchedParams,sessionInserted=false;const db={query:async(sql,params=[])=>{if(sql.includes("WITH matched AS")){matchedParams=params;return{rowCount:1,rows:[{user_id:"11111111-1111-4111-8111-111111111111"}]};}if(sql.includes("INSERT INTO admin_sessions")){sessionInserted=true;return{rowCount:1,rows:[]};}throw new Error(`Unexpected SQL: ${sql}`);}};const config=loadConfig({NODE_ENV:"test",DATABASE_URL:"postgres://unused",AUTH_MODE:"local",ADMIN_PASSWORD_HASH:hashPassword("legacy-secret"),SESSION_COOKIE_SECURE:"false",LOG_LEVEL:"silent"});const app=await buildApp({config,db});t.after(()=>app.close());const code="RECOVERY-CODE-ABC123";const response=await app.inject({method:"POST",url:"/api/auth/recovery-codes/consume",payload:{username:"owner@example.com",code}});assert.equal(response.statusCode,200);assert.equal(response.json().recoveryCodeConsumed,true);assert.equal(matchedParams[0],hashToken(code));assert.equal(matchedParams.includes(code),false);assert.equal(sessionInserted,true);assert.ok(response.headers["set-cookie"]);});
