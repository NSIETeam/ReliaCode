import assert from "node:assert/strict";
import test from "node:test";
import { configureDatabaseClient,currentDatabaseContext,runWithDatabaseContext,useSystemDatabaseContext,useTenantDatabaseContext } from "../src/database-context.mjs";

test("database context defaults to system and can be narrowed to one tenant",async()=>{await runWithDatabaseContext(async()=>{assert.equal(currentDatabaseContext().mode,"system");useTenantDatabaseContext("11111111-1111-4111-8111-111111111111");assert.equal(currentDatabaseContext().tenantId,"11111111-1111-4111-8111-111111111111");const calls=[],client={query:async(sql,params)=>{calls.push({sql,params});}};await configureDatabaseClient(client);assert.deepEqual(calls[0].params,["11111111-1111-4111-8111-111111111111"]);useSystemDatabaseContext();await configureDatabaseClient(client);assert.match(calls[1].sql,/system_access','on/);});});

test("parallel request contexts cannot overwrite each other",async()=>{const tenant=id=>runWithDatabaseContext(async()=>{useTenantDatabaseContext(id);await new Promise(resolve=>setImmediate(resolve));return currentDatabaseContext().tenantId;});assert.deepEqual(await Promise.all([tenant("tenant-a"),tenant("tenant-b")]),["tenant-a","tenant-b"]);});
