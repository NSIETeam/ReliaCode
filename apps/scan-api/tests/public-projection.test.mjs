import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';

const workspace = {
  schemaVersion:1,
  initialized:true,
  workspace:{ id:'11111111-1111-4111-8111-111111111111', brandName:'Demo', createdAt:'2026-08-25' },
  accounts:[], currentAccountId:null,
  products:[{ id:'22222222-2222-4222-8222-222222222222', name:'Demo product', gtin:'06912345678902' }],
  codeBatches:[],
  objects:{ object1:{ code:'RC-ITEM-0001', publicId:'33333333-3333-4333-8333-333333333333', level:'ITEM', lot:null, status:'COMMISSIONED', productId:'22222222-2222-4222-8222-222222222222', createdAt:'2026-08-25T00:00:00.000Z' } },
  events:[{ code:'rc-item-0001', action:'VERIFY', time:'2026-08-25T01:00:00.000Z' }],
  campaigns:[], ledger:[], risks:[], agentRuns:[]
};

function makeDb() {
  let session;
  const queries=[];
  return {
    queries,
    async query(sql, params=[]) {
      queries.push({ sql, params });
      if (sql.includes('FROM admin_sessions WHERE token_hash=$1')) {
        return session ? { rowCount:1, rows:[{ ...session, expires_at:new Date(Date.now()+3600000) }] } : { rowCount:0, rows:[] };
      }
      if (sql.includes('FROM local_users')) return { rowCount:0, rows:[] };
      if (sql.includes('INSERT INTO admin_sessions')) { session={ token_hash:params[0], csrf_token_hash:params[1] }; return { rowCount:1, rows:[] }; }
      if (sql.includes('DELETE FROM admin_sessions')) return { rowCount:0, rows:[] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async transaction(work) {
      const client={ query:async (sql, params=[]) => {
        queries.push({ sql, params });
        if (sql.includes('DELETE FROM admin_sessions')) return { rowCount:0, rows:[] };
        if (sql.includes('INSERT INTO admin_sessions')) { session={ token_hash:params[0],csrf_token_hash:params[1] };return { rowCount:1,rows:[] }; }
        if (sql.includes('INSERT INTO admin_workspaces')) return { rowCount:1, rows:[{ workspace, version:0, updated_at:'2026-08-26T00:00:00.000Z' }] };
        if (sql.includes('DELETE FROM admin_public_objects')) return { rowCount:1, rows:[] };
        if (sql.includes('INSERT INTO admin_public_objects')) return { rowCount:1, rows:[] };
        throw new Error(`Unexpected transaction SQL: ${sql}`);
      }};
      return work(client);
    }
  };
}

test('workspace projection encodes event arrays as JSONB strings', async (t) => {
  const config=loadConfig({ NODE_ENV:'test', DATABASE_URL:'postgres://unused', AUTH_MODE:'local', ADMIN_PASSWORD_HASH:hashPassword('secret'), SESSION_COOKIE_SECURE:'false', CORS_ORIGINS:'http://localhost:4173', LOG_LEVEL:'silent' });
  const db=makeDb();
  const app=await buildApp({ config, db });
  t.after(() => app.close());
  const login=await app.inject({ method:'POST', url:'/api/auth/login', payload:{ username:'admin', password:'secret' } });
  assert.equal(login.statusCode, 200);
  const cookies=[].concat(login.headers['set-cookie'] || []).map((value) => value.split(';')[0]).join('; ');
  const csrf=cookies.match(/reliacode_csrf=([^;]+)/)[1];
  const response=await app.inject({ method:'PUT', url:'/api/v1/workspace', headers:{ cookie:cookies, 'x-csrf-token':csrf }, payload:{ version:0, workspace } });
  assert.equal(response.statusCode, 200);
  const projection=db.queries.find(({ sql }) => sql.includes('INSERT INTO admin_public_objects'));
  assert.ok(projection);
  const encodedEvents=projection.params[8];
  assert.equal(typeof encodedEvents, 'string');
  assert.deepEqual(JSON.parse(encodedEvents), [{ type:'VERIFY', time:'2026-08-25T01:00:00.000Z' }]);
});

test('production insecure HTTP bootstrap does not emit HSTS', async (t) => {
  const config=loadConfig({ NODE_ENV:'production', DATABASE_URL:'postgres://unused', AUTH_MODE:'local', ADMIN_PASSWORD_HASH:hashPassword('secret'), SESSION_COOKIE_SECURE:'false', ALLOW_INSECURE_HTTP:'true', CORS_ORIGINS:'http://8.140.52.117', SESSION_FINGERPRINT_KEY:Buffer.alloc(32,4).toString('base64url'), LOG_LEVEL:'silent' });
  const app=await buildApp({ config, db:{ query:async () => ({ rowCount:1, rows:[{ current:true }] }) } });
  t.after(() => app.close());
  const response=await app.inject({ method:'GET', url:'/health/live' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['strict-transport-security'], undefined);
});
