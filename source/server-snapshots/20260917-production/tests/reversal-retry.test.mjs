import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const scanner = fs.readFileSync(path.join(root, 'public/js/scanner.js'), 'utf8');
const warehouse = fs.readFileSync(path.join(root, 'views/warehouse.ejs'), 'utf8');
const factory = fs.readFileSync(path.join(root, 'views/factory.ejs'), 'utf8');
const generate = fs.readFileSync(path.join(root, 'views/generate.ejs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function helper(fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout });
  vm.runInContext(scanner, context);
  return context.cancelCodeWithReconciliation;
}

test('a confirmed cancellation does not need a second status request', async () => {
  let calls = 0;
  const cancel = helper(async () => { calls++; return { ok: true, json: async () => ({ success: true }) }; });
  const result = await cancel('BTEST123', '/api/codes/cancel-stock', 'stock');
  assert.equal(result.success, true);
  assert.equal(calls, 1);
});

test('lost response is reconciled from read-only server state', async () => {
  const cancel = helper(async url => {
    if (url === '/api/shipments/cancel') throw new Error('network timeout');
    assert.match(url, /kind=shipment/);
    return { ok: true, json: async () => ({ success: true, settled: true, state: '已无对应业务关联' }) };
  });
  const result = await cancel('BTEST123', '/api/shipments/cancel', 'shipment');
  assert.equal(result.success, true);
  assert.equal(result.reconciled, true);
});

test('failed or unverified cancellation stays in the list', async () => {
  const stillActive = helper(async url => url === '/api/codes/cancel-stock'
    ? { ok: true, json: async () => ({ success: false, msg: '仍在库' }) }
    : { ok: true, json: async () => ({ success: true, settled: false }) });
  assert.equal((await stillActive('BTEST123', '/api/codes/cancel-stock', 'stock')).success, false);
  const disconnected = helper(async () => { throw new Error('offline'); });
  const result = await disconnected('BTEST123', '/api/codes/cancel-stock', 'stock');
  assert.equal(result.success, false);
  assert.equal(result.uncertain, true);
});

test('shipment and cancellation UIs retain unresolved codes', () => {
  assert.match(server, /success: successList\.length > 0,[\s\S]*partial_success:/);
  assert.match(server, /app\.get\('\/api\/codes\/reversal-state'/);
  assert.match(warehouse, /pendingCodes = pendingCodes\.filter\(code => !shippedSet\.has\(code\)\)/);
  assert.match(warehouse, /cancelShipCodes = results\.filter\(result => !result\.success\)/);
  assert.match(factory, /cancelStockCodes = results\.filter\(r => !r\.success\)/);
});

test('product create has stable retry key and partial enhancement save stays open', () => {
  assert.match(server, /app\.post\('\/api\/products', requireRole\([^\n]+optionalBrowserIdempotency/);
  assert.match(generate, /productCreateRequestBody && productCreateRequestBody !== requestBody/);
  assert.match(generate, /productFormDirty = true;[\s\S]*saveButton\.disabled = false;[\s\S]*扩展内容未完成/);
  assert.match(generate, /toast\(status\.textContent \+ '；请在当前窗口再次点击保存'/);
});
