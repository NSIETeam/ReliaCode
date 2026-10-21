import assert from "node:assert/strict";
import test from "node:test";
import { requestId } from "../src/request-id.mjs";

test("request IDs preserve bounded interoperable values",()=>{
  assert.equal(requestId("erp:trace-2026_08.30"),"erp:trace-2026_08.30");
});

test("request IDs replace log injection and high-cardinality payloads",()=>{
  for(const unsafe of ["",`x\nforged`,"x".repeat(65)," leading",["duplicate"]]){
    const value=requestId(unsafe);
    assert.match(value,/^[0-9a-f-]{36}$/);
    assert.notEqual(value,unsafe);
  }
});
