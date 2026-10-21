import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeWorkspace, semanticHash, CATEGORIES } from "../src/workspace-normalization-contract.mjs";

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const organizationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fixture = JSON.parse(await readFile(new URL("./fixtures/workspace-normalization-golden.json", import.meta.url)));

test("normalizes the golden legacy workspace into explicit categories", () => {
  const result = normalizeWorkspace(fixture, { tenantId, organizationId });
  assert.deepEqual(Object.keys(result), CATEGORIES);
  assert.equal(result.preferences.length, 1);
  assert.equal(result.products.length, 1);
  assert.equal(result.codeBatches.length, 1);
  assert.equal(result.objects.length, 1);
  assert.equal(result.traceEvents.length, 1);
  assert.equal(result.agentRuns.length, 1);
  assert.equal(result.risks.length, 1);
  assert.ok(result.rejects.some((item) => item.reason === "OBJECT_REFERENCE_OR_SHAPE_INVALID"));
  assert.ok(result.rejects.some((item) => item.reason === "TRACE_EVENT_NOT_VERIFIED_OR_OBJECT_MISSING"));
  assert.equal(JSON.stringify(result.rejects).includes("do-not-copy"), false);
  assert.equal(result.traceEvents[0].verificationStatus, "VERIFIED");
});

test("semantic hashes and ordering are invariant to object key order and source order", () => {
  const one = normalizeWorkspace(fixture, { tenantId, organizationId });
  const reversed = { ...fixture, products: [...fixture.products].reverse(), events: [...fixture.events].reverse() };
  const two = normalizeWorkspace(reversed, { tenantId, organizationId });
  assert.deepEqual(one.products.map((item) => item.semanticHash), two.products.map((item) => item.semanticHash));
  assert.deepEqual(one.traceEvents.map((item) => item.semanticHash), two.traceEvents.map((item) => item.semanticHash));
  assert.equal(semanticHash({ b: 2, a: 1 }), semanticHash({ a: 1, b: 2 }));
});

test("context is mandatory and mismatched records are rejected without stopping valid records", () => {
  assert.throws(() => normalizeWorkspace({}, { tenantId: "bad", organizationId }), /tenantId must be a UUID/);
  const result = normalizeWorkspace({ products: [fixture.products[0], { ...fixture.products[0], tenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }] }, { tenantId, organizationId });
  assert.equal(result.products.length, 1);
  assert.equal(result.rejects[0].reason, "TENANT_OR_ORGANIZATION_MISMATCH");
});
