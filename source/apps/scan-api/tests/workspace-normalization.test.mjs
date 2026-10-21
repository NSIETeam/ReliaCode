import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNormalizationPlan, resolveSafeMapping } from '../src/workspace-normalization.mjs';

const local = { id:'11111111-1111-4111-8111-111111111111', tenant_id:'22222222-2222-4222-8222-222222222222' };
const mapping = { local_organization_id:local.id, local_tenant_id:local.tenant_id, core_tenant_id:local.tenant_id, core_organization_id:'33333333-3333-4333-8333-333333333333', core_organization_tenant_id:local.tenant_id };
const product = { id:'44444444-4444-4444-8444-444444444444', sku:'SKU-1', name:'Product' };
const object = { id:'55555555-5555-4555-8555-555555555555', productId:product.id, code:'CODE-1', level:'ITEM' };

test('safe mapping rejects missing or cross-tenant identity', () => {
  assert.equal(resolveSafeMapping(local, []), null);
  assert.equal(resolveSafeMapping(local, [{ ...mapping, core_tenant_id:'66666666-6666-4666-8666-666666666666' }]), null);
  assert.equal(resolveSafeMapping(local, [mapping]), mapping);
});

test('normalization plan is tenant isolated and idempotent SQL', () => {
  const result = buildNormalizationPlan({ localOrganization:local, mapping, workspace:{ products:[product], objects:{ [object.id]:object }, events:[] } });
  assert.equal(result.statements.length, 2);
  assert.ok(result.statements.every((item) => item.params.includes(local.tenant_id)));
  assert.ok(result.statements.every((item) => item.sql.includes('ON CONFLICT')));
});

test('invalid payloads are skipped and raw payload is not returned', () => {
  const result = buildNormalizationPlan({ localOrganization:local, mapping, workspace:{ products:[product, { name:'bad', secret:'do-not-log' }], objects:{ bad:{ code:'x' } }, events:[{ metadata:{ secret:'do-not-log' } }] } });
  assert.equal(result.statements.length, 1);
  assert.equal(result.stats.skippedInvalid, 3);
  assert.equal(JSON.stringify(result).includes('do-not-log'), false);
});

test('legacy normalization rejects products with invalid GTIN check digits', () => {
  const invalidProduct = { ...product, gtin:'06912345678901' };
  const result = buildNormalizationPlan({ localOrganization:local, mapping, workspace:{ products:[invalidProduct], objects:{ [object.id]:object }, events:[] } });
  assert.equal(result.statements.length, 0);
  assert.equal(result.stats.skippedInvalid, 2);
});

test('unmapped workspace produces no writes and counts records', () => {
  const result = buildNormalizationPlan({ localOrganization:local, mapping:null, workspace:{ products:[product], objects:{ [object.id]:object }, events:[{}] } });
  assert.equal(result.statements.length, 0);
  assert.equal(result.stats.skippedUnmapped, 3);
});
