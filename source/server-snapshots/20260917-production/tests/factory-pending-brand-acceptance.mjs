import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

assert.equal(process.env.RELIACODE_ACCEPTANCE_STAGE, '1', 'Only run against an isolated stage');
assert.match(process.env.RELIACODE_DATA_DIR || '', /^\/tmp\/reliacode-stage-[^/]+\/data$/);
const base = process.env.RELIACODE_ACCEPTANCE_BASE || 'http://127.0.0.1:37124';
assert.equal(new URL(base).hostname, '127.0.0.1');
const require = createRequire(import.meta.url);
const { db } = require('../database.js');
const nonce = Date.now().toString(36);

async function login(username, password) {
  const response = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username, password })
  });
  assert.equal(response.status, 302, `${username} login`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, `${username} session cookie`);
  return cookie;
}

async function api(path, cookie, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json() };
}

const product = db.prepare('INSERT INTO products(name,spec,box_size,factory_id,brand_id) VALUES(?,?,?,?,?)')
  .run(`验收待入库-${nonce}`, '10kg', 2, 2, 2).lastInsertRowid;
db.prepare('INSERT INTO product_factories(product_id,factory_id) VALUES(?,?)').run(product, 2);
function addBox(suffix, count) {
  const boxCode = `BACC${nonce}${suffix}`.toUpperCase();
  const id = db.prepare("INSERT INTO boxes(box_code,product_id,brand_id,batch_no,box_size,item_count,status,receipt_factory_id) VALUES(?,?,?,?,?,?,?,?)")
    .run(boxCode, product, 2, `ACC-${nonce}`, 2, count, 'packing', 2).lastInsertRowid;
  for (let i = 0; i < count; i++) {
    db.prepare("INSERT INTO items(item_code,box_id,product_id,brand_id,batch_no,status,receipt_factory_id) VALUES(?,?,?,?,?,?,?)")
      .run(`SACC${nonce}${suffix}${i}`.toUpperCase(), id, product, 2, `ACC-${nonce}`, 'packing', 2);
  }
  return boxCode;
}
const box1 = addBox('A', 2);
const box2 = addBox('B', 2);
const partial = addBox('C', 1);

const admin = await login('stage_admin', 'StageAdmin123!');
const factory = await login('stage_factory', 'StageFactory123!');
const listing = await api('/api/factory/pack/pending-stock', factory);
assert.equal(listing.status, 200);
assert.deepEqual(listing.data.boxes.filter(x => [box1, box2, partial].includes(x.box_code)).map(x => x.box_code).sort(), [box1, box2].sort());
for (const box of listing.data.boxes.filter(x => [box1, box2].includes(x.box_code))) {
  assert.equal(box.quantity, 2);
  assert.match(box.product_name, /验收待入库/);
}

const invalid = await api('/api/factory/pack/confirm-stock', factory, 'POST', { box_codes: [box1, partial] });
assert.equal(invalid.status, 409);
assert.equal(db.prepare('SELECT status FROM boxes WHERE box_code=?').get(box1).status, 'packing', 'batch must be atomic');

const confirm = await api('/api/factory/pack/confirm-stock', factory, 'POST', { box_codes: [box1, box2] });
assert.equal(confirm.status, 200);
assert.equal(confirm.data.confirmed_count, 2);
for (const code of [box1, box2]) {
  const row = db.prepare('SELECT id,status FROM boxes WHERE box_code=?').get(code);
  assert.equal(row.status, 'in_stock');
  assert.deepEqual(db.prepare('SELECT DISTINCT status FROM items WHERE box_id=?').all(row.id), [{ status: 'scanned' }]);
}
const retry = await api('/api/factory/pack/confirm-stock', factory, 'POST', { box_codes: [box1, box2] });
assert.equal(retry.status, 200);
assert.equal(retry.data.confirmed_count, 0);
assert.equal(retry.data.already_confirmed_count, 2);

const movable = db.prepare('INSERT INTO products(name,spec,box_size,factory_id,brand_id) VALUES(?,?,?,?,?)')
  .run(`验收品牌切换-${nonce}`, '10kg', 2, 2, 3).lastInsertRowid;
db.prepare('INSERT INTO product_factories(product_id,factory_id) VALUES(?,?)').run(movable, 2);
const changed = await api(`/api/products/${movable}`, admin, 'PUT', {
  name: `验收品牌切换-${nonce}`, spec: '10kg', box_size: 2,
  factory_id: 2, factory_ids: [2], brand_id: 4, version: 1
});
assert.equal(changed.status, 200, JSON.stringify(changed.data));
assert.equal(changed.data.brand_changed, true);
assert.equal(db.prepare('SELECT brand_id FROM products WHERE id=?').get(movable).brand_id, 4);

const locked = db.prepare('INSERT INTO products(name,spec,box_size,factory_id,brand_id) VALUES(?,?,?,?,?)')
  .run(`验收有历史码-${nonce}`, '10kg', 2, 2, 3).lastInsertRowid;
db.prepare('INSERT INTO product_factories(product_id,factory_id) VALUES(?,?)').run(locked, 2);
db.prepare('INSERT INTO items(item_code,product_id,brand_id,status) VALUES(?,?,?,?)')
  .run(`SACC${nonce}LOCK`.toUpperCase(), locked, 3, 'in_stock');
const refused = await api(`/api/products/${locked}`, admin, 'PUT', {
  name: `验收有历史码-${nonce}`, spec: '10kg', box_size: 2,
  factory_id: 2, factory_ids: [2], brand_id: 4, version: 1
});
assert.equal(refused.status, 409);
assert.equal(refused.data.code, 'PRODUCT_BRAND_HAS_CODES');
assert.equal(db.prepare('SELECT brand_id FROM products WHERE id=?').get(locked).brand_id, 3);

console.log(JSON.stringify({ stage: true, pendingList: 2, partialExcluded: true, atomicFailure: true,
  confirmedBoxes: 2, retryIdempotent: true, unusedBrandSwitched: true, historicalBrandLocked: true }));
