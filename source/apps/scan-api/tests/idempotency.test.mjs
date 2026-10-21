import assert from "node:assert/strict";
import test from "node:test";
import { getIdempotentResponse, lockIdempotencyKey, requestHash } from "../src/idempotency.mjs";

test("request hash is stable and operation scoped", () => {
  assert.equal(requestHash("A", { value:1 }), requestHash("A", { value:1 }));
  assert.notEqual(requestHash("A", { value:1 }), requestHash("B", { value:1 }));
});

test("idempotency key is transaction locked before mutation", async () => {
  const calls = [];
  await lockIdempotencyKey({ query:async (sql,params) => calls.push({sql,params}) }, "tenant", "key-123456789012");
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.equal(calls[0].params[0], "tenant:key-123456789012");
});

test("same key with a different request is rejected", async () => {
  const client = { query:async () => ({ rowCount:1, rows:[{ request_hash:"old",response_status:201,response_body:{} }] }) };
  await assert.rejects(() => getIdempotentResponse(client, "tenant", "key", "new"), { code:"IDEMPOTENCY_CONFLICT" });
});
