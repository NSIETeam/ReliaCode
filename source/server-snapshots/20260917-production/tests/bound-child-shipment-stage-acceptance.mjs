import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

assert.equal(process.env.RELIACODE_ACCEPTANCE_STAGE, '1', 'Only run against an isolated stage');
assert.match(process.env.RELIACODE_DATA_DIR || '', /^\/tmp\/reliacode-stage-[^/]+\/data$/);
const base = 'http://127.0.0.1:37124';
const require = createRequire(import.meta.url);
const { db, hashPassword } = require('../database.js');
const nonce = Date.now().toString(36).toUpperCase();
const username = `stage_brand_${nonce.toLowerCase()}`;
const password = 'StageBrand123!';
db.prepare('INSERT INTO users(username,password_hash,display_name,role,brand_id) VALUES (?,?,?,?,?)')
  .run(username, hashPassword(password), '隔离验收品牌', 'brand', 2);
const productId = db.prepare('INSERT INTO products(name,spec,brand_id,factory_id,box_size) VALUES (?,?,?,?,?)')
  .run(`箱内子码发货验收${nonce}`, '10kg', 2, 2, 2).lastInsertRowid;
db.prepare('INSERT INTO product_factories(product_id,factory_id) VALUES (?,?)').run(productId, 2);
const boxCode = `BCH${nonce}`;
const batch = `B-${nonce}`;
const boxId = db.prepare(`INSERT INTO boxes(box_code,product_id,brand_id,batch_no,box_size,item_count,status,receipt_factory_id)
  VALUES (?,?,?,?,?,?,'in_stock',?)`).run(boxCode, productId, 2, batch, 2, 2, 2).lastInsertRowid;
const children = [`SCH${nonce}A`, `SCH${nonce}B`];
for (const code of children) {
  db.prepare(`INSERT INTO items(item_code,box_id,product_id,brand_id,batch_no,status,boxed_at,receipt_factory_id)
    VALUES (?,?,?,?,?,'scanned',datetime('now'),?)`).run(code, boxId, productId, 2, batch, 2);
}
const distributorId = db.prepare('INSERT INTO distributors(name,brand_id) VALUES (?,?)')
  .run(`验收代理${nonce}`, 2).lastInsertRowid;

const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
  body: new URLSearchParams({ username, password }) });
assert.equal(login.status, 302);
const cookie = login.headers.get('set-cookie').split(';')[0];
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { cookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}
const page = await fetch(`${base}/warehouse`, { headers: { cookie } });
assert.equal(page.status, 200);
const html = await page.text();
assert.match(html, /id="shipBoxBtn"[^>]*>确认发货/);
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
  if (match[1].trim()) new Script(match[1], { filename: 'warehouse-inline.js' });
}
const source = readFileSync(new URL('../views/warehouse.ejs', import.meta.url), 'utf8');
assert.match(source, /document\.getElementById\('shipBoxBtn'\)\.addEventListener\('click', batchShip\)/);
assert.match(source, /shipSubmitting = true;\s*updateShipReadyState\(\)/);
assert.doesNotMatch(source, /shipButton\.disabled/);
assert.doesNotMatch(source, /请扫描箱码进行整箱发货/);

const info = await api(`/api/warehouse/code-info?code=${children[0]}`);
assert.equal(info.data.success, true);
assert.equal(info.data.bound_to_box, true);
assert.equal(info.data.box_code, boxCode);

const payload = codes => ({ codes, distributor_id: distributorId, order_no: `ACC-${nonce}` });
const mixed = await api('/api/shipments/batch-ship', 'POST', payload([boxCode, children[0]]));
assert.equal(mixed.status, 409);
assert.equal(mixed.data.success, false);
assert.equal(mixed.data.shipped.length, 0);
assert.equal(db.prepare('SELECT status FROM items WHERE item_code=?').get(children[0]).status, 'scanned');

const childShip = await api('/api/shipments/batch-ship', 'POST', payload([children[0]]));
assert.equal(childShip.data.success, true, JSON.stringify(childShip.data));
assert.equal(childShip.data.shipped[0].type, 'item');
assert.equal(db.prepare('SELECT status FROM items WHERE item_code=?').get(children[0]).status, 'shipped');
assert.equal(db.prepare('SELECT status FROM items WHERE item_code=?').get(children[1]).status, 'scanned');
assert.equal(db.prepare('SELECT status FROM boxes WHERE box_code=?').get(boxCode).status, 'in_stock');
assert.equal(db.prepare('SELECT box_id FROM shipments WHERE item_code=?').get(children[0]).box_id, boxId);

const wrongCancel = await api('/api/shipments/cancel', 'POST', { code: boxCode });
assert.equal(wrongCancel.data.success, false);
assert.match(wrongCancel.data.msg, /对应子码取消/);
assert.equal(db.prepare('SELECT status FROM items WHERE item_code=?').get(children[0]).status, 'shipped');
const boxReversal = await api(`/api/codes/reversal-state?kind=shipment&code=${boxCode}`);
assert.equal(boxReversal.data.settled, true, 'box itself was not shipped');

const wholeWhilePartial = await api('/api/shipments/batch-ship', 'POST', payload([boxCode]));
assert.equal(wholeWhilePartial.data.success, false);
assert.equal(db.prepare('SELECT status FROM boxes WHERE box_code=?').get(boxCode).status, 'in_stock');
const cancel = await api('/api/shipments/cancel', 'POST', { code: children[0] });
assert.equal(cancel.data.success, true);
assert.equal(db.prepare('SELECT status FROM items WHERE item_code=?').get(children[0]).status, 'scanned');
const wholeAfterCancel = await api('/api/shipments/batch-ship', 'POST', payload([boxCode]));
assert.equal(wholeAfterCancel.data.success, true, JSON.stringify(wholeAfterCancel.data));
assert.equal(wholeAfterCancel.data.shipped[0].item_count, 2);
console.log(JSON.stringify({ stage: true, brandPageRendered: true, childRecognized: true,
  mixedShipmentAtomic: true, boundChildShipped: true, siblingUnaffected: true,
  partialBoxBlocked: true, wrongBoxCancelBlocked: true, cancellationRestoredFullBox: true }));
