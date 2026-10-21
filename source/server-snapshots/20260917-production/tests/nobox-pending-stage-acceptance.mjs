import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';

assert.equal(process.env.RELIACODE_ACCEPTANCE_STAGE, '1', 'Only run against an isolated stage');
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
async function api(path, cookie, method = 'GET', body, key) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { cookie, origin: base, ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json(), replayed: response.headers.get('idempotency-replayed') };
}

const admin = await login('stage_admin', 'StageAdmin123!');
const factory = await login('stage_factory', 'StageFactory123!');
const created = await api('/api/products', admin, 'POST', {
  name: `无箱码验收${nonce}`, spec: '10kg', brand_id: 2, factory_id: 2, factory_ids: [2], box_size: 1
}, `nobox-product-${nonce}`);
assert.equal(created.data.success, true, JSON.stringify(created.data));
const productId = Number(created.data.id);
const codes = [`SNB${nonce}A`, `SNB${nonce}B`];
for (const code of codes) {
  db.prepare("INSERT INTO items(item_code,brand_id,status) VALUES (?,?,'in_stock')").run(code, 2);
  const staged = await api('/api/factory/pack/pending-nobox', factory, 'POST', {
    item_code: code, product_id: productId, batch_no: `B-${nonce}`
  });
  assert.equal(staged.data.success, true, JSON.stringify(staged.data));
  assert.equal(db.prepare('SELECT status FROM items WHERE item_code=?').get(code).status, 'in_stock');
}
const pending = await api('/api/factory/pack/pending-nobox', factory);
assert.equal(pending.data.success, true);
assert.equal(pending.data.items.filter(item => codes.includes(item.item_code)).length, 2);
assert.equal(pending.data.items.find(item => item.item_code === codes[0]).box_code, null);
assert.equal(pending.data.items.find(item => item.item_code === codes[0]).quantity, 1);

const legacy = await api('/api/factory/pack/scan-nobox', factory, 'POST', {
  item_code: codes[0], product_id: productId, batch_no: `B-${nonce}`
});
assert.equal(legacy.data.success, false, 'legacy direct-stock endpoint must not bypass the pending list');

const rejected = await api('/api/factory/pack/confirm-nobox', factory, 'POST', {
  item_codes: [codes[0], `SNB${nonce}MISSING`]
}, `nobox-reject-${nonce}`);
assert.equal(rejected.data.success, false);
assert.equal(db.prepare('SELECT status FROM items WHERE item_code=?').get(codes[0]).status, 'in_stock');

const key = `nobox-confirm-${nonce}`;
const confirmed = await api('/api/factory/pack/confirm-nobox', factory, 'POST', { item_codes: codes }, key);
assert.equal(confirmed.data.success, true, JSON.stringify(confirmed.data));
assert.equal(confirmed.data.confirmed_count, 2);
const replay = await api('/api/factory/pack/confirm-nobox', factory, 'POST', { item_codes: codes }, key);
assert.equal(replay.data.confirmed_count, 2);
assert.equal(replay.replayed, 'true');
for (const code of codes) {
  const item = db.prepare('SELECT * FROM items WHERE item_code=?').get(code);
  assert.equal(item.status, 'scanned');
  assert.equal(item.product_id, productId);
  assert.equal(item.receipt_factory_id, 2);
  assert.ok(item.boxed_at);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM factory_nobox_pending WHERE item_code=?').get(code).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pack_records WHERE item_code=? AND action='nobox'").get(code).c, 1);
}
const finalList = await api('/api/factory/pack/pending-nobox', factory);
assert.equal(finalList.data.items.some(item => codes.includes(item.item_code)), false);

const removedCode = `SNB${nonce}REMOVE`;
db.prepare("INSERT INTO items(item_code,brand_id,status) VALUES (?,?,'in_stock')").run(removedCode, 2);
const addRemoved = await api('/api/factory/pack/pending-nobox', factory, 'POST', {
  item_code: removedCode, product_id: productId, batch_no: `B-${nonce}`
});
assert.equal(addRemoved.data.success, true);
const removed = await api(`/api/factory/pack/pending-nobox/${removedCode}`, factory, 'DELETE');
assert.equal(removed.data.success, true);
assert.equal(db.prepare('SELECT status FROM items WHERE item_code=?').get(removedCode).status, 'in_stock');

const page = await fetch(`${base}/factory`, { headers: { cookie: factory } });
assert.equal(page.status, 200);
const html = await page.text();
assert.match(html, /无箱码待入库清单/);
assert.match(html, /confirmPendingNoBoxBtn/);
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
  if (match[1].trim()) new Script(match[1], { filename: 'factory-inline.js' });
}
console.log(JSON.stringify({ stage: true, stagedWithoutStock: 2, atomicConfirmation: true,
  retryReplayed: true, removedWithoutStock: true, pageRendered: true }));
