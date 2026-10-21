import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

assert.equal(process.env.RELIACODE_ACCEPTANCE_STAGE, '1');
assert.match(process.env.RELIACODE_DATA_DIR || '', /^\/tmp\/reliacode-stage-[^/]+\/data$/);
const base = 'http://127.0.0.1:37124';
const require = createRequire(import.meta.url);
const { db } = require('../database.js');
const nonce = Date.now().toString(36).toUpperCase();

async function login(username, password) {
  const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username, password }) });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie').split(';')[0];
}
async function request(path, cookie, method = 'GET', body, key) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    cookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {})
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json(), replayed: response.headers.get('idempotency-replayed') };
}

const admin = await login('stage_admin', 'StageAdmin123!');
const factory = await login('stage_factory', 'StageFactory123!');
for (const [path, cookie] of [['/factory', factory], ['/warehouse', admin], ['/generate', admin]]) {
  const page = await fetch(`${base}${path}`, { headers: { cookie } });
  assert.equal(page.status, 200, `${path} should render`);
  assert.match(await page.text(), /scanner\.js\?v=20260923a|productCreateRequestKey/);
}
const factoryPage = readFileSync(new URL('../views/factory.ejs', import.meta.url), 'utf8');
assert.match(factoryPage, /function cameraScan\(\)\s*\{\s*\/\/ 允许先开启摄像头扫箱码/);
assert.match(factoryPage, /if \(\/\^B\/i\.test\(code\)\) \{\s*await startPacking\(code\)/);
const productBody = { name: `幂等产品${nonce}`, spec: '10kg', box_size: 1, brand_id: 2, factory_id: 2, factory_ids: [2] };
const key = `product-create-${nonce}`;
const created = await request('/api/products', admin, 'POST', productBody, key);
assert.equal(created.data.success, true, JSON.stringify(created.data));
const replay = await request('/api/products', admin, 'POST', productBody, key);
assert.equal(replay.data.id, created.data.id);
assert.equal(replay.replayed, 'true');
assert.equal(db.prepare('SELECT COUNT(*) c FROM products WHERE name=?').get(productBody.name).c, 1);
const productId = Number(created.data.id);
const distributorId = db.prepare('INSERT INTO distributors(name,brand_id) VALUES(?,?)').run(`验收代理${nonce}`, 2).lastInsertRowid;

const shippedCode = `SACC${nonce}SHIP`;
db.prepare("INSERT INTO items(item_code,product_id,brand_id,batch_no,status,boxed_at,receipt_factory_id) VALUES(?,?,?,?,?,datetime('now'),?)")
  .run(shippedCode, productId, 2, `ACC-${nonce}`, 'scanned', 2);
const partial = await request('/api/shipments/batch-ship', admin, 'POST', {
  codes: [shippedCode, `SACC${nonce}MISSING`], distributor_id: distributorId, order_no: `ACC-${nonce}`
});
assert.equal(partial.data.success, true, JSON.stringify(partial.data));
assert.equal(partial.data.partial_success, true);
assert.equal(partial.data.shipped.length, 1);
assert.equal(partial.data.failed.length, 1);
assert.equal(db.prepare('SELECT status FROM items WHERE item_code=?').get(shippedCode).status, 'shipped');
const allFailed = await request('/api/shipments/batch-ship', admin, 'POST', {
  codes: [`SACC${nonce}MISSING`], distributor_id: distributorId, order_no: `ACC-${nonce}`
});
assert.equal(allFailed.data.success, false);
assert.equal(allFailed.data.failed.length, 1);

const beforeShipment = await request(`/api/codes/reversal-state?kind=shipment&code=${shippedCode}`, admin);
assert.equal(beforeShipment.data.settled, false);
const canceledShipment = await request('/api/shipments/cancel', admin, 'POST', { code: shippedCode });
assert.equal(canceledShipment.data.success, true);
const afterShipment = await request(`/api/codes/reversal-state?kind=shipment&code=${shippedCode}`, admin);
assert.equal(afterShipment.data.settled, true);

const stockCode = `SACC${nonce}STOCK`;
db.prepare("INSERT INTO items(item_code,product_id,brand_id,batch_no,status,boxed_at,receipt_factory_id) VALUES(?,?,?,?,?,datetime('now'),?)")
  .run(stockCode, productId, 2, `ACC-${nonce}`, 'scanned', 2);
const beforeStock = await request(`/api/codes/reversal-state?kind=stock&code=${stockCode}`, factory);
assert.equal(beforeStock.data.settled, false);
const canceledStock = await request('/api/codes/cancel-stock', factory, 'POST', { code: stockCode });
assert.equal(canceledStock.data.success, true);
const afterStock = await request(`/api/codes/reversal-state?kind=stock&code=${stockCode}`, factory);
assert.equal(afterStock.data.settled, true, JSON.stringify(afterStock.data));
assert.equal(db.prepare('SELECT product_id FROM items WHERE item_code=?').get(stockCode).product_id, null);

console.log(JSON.stringify({ stage: true, productCreateReplayed: true, partialShipment: true,
  allShipmentFailuresReported: true, shipmentReconciled: true, stockReconciledForFactory: true }));
