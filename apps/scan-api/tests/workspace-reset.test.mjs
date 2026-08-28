import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';

function makeDb() {
  let session = null;
  let workspace = { workspace:{ schemaVersion:1 }, version:3, updated_at:'2026-08-26T00:00:00.000Z' };
  let publicObjectsDeleted = false;
  return {
    get publicObjectsDeleted() { return publicObjectsDeleted; },
    async query(sql, params=[]) {
      if (sql.includes('FROM admin_sessions WHERE token_hash=$1')) {
        return session ? { rowCount:1, rows:[{ ...session, expires_at:new Date(Date.now()+3600000) }] } : { rowCount:0, rows:[] };
      }
      if (sql.includes('FROM local_users')) return { rowCount:0, rows:[] };
      if (sql.includes('DELETE FROM admin_sessions')) { return { rowCount:0, rows:[] }; }
      if (sql.includes('INSERT INTO admin_sessions')) {
        session = { token_hash:params[0], csrf_token_hash:params[1] };
        return { rowCount:1, rows:[] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async transaction(work) {
      const client = { query:async (sql, params=[]) => {
        if (sql.includes('SELECT workspace,version,updated_at FROM admin_workspaces')) return workspace ? { rowCount:1, rows:[workspace] } : { rowCount:0, rows:[] };
        if (sql.includes('UPDATE admin_workspaces SET')) {
          workspace = { workspace:params[0], version:workspace.version+1, updated_at:'2026-08-26T01:00:00.000Z' };
          return { rowCount:1, rows:[workspace] };
        }
        if (sql.includes('INSERT INTO admin_workspaces')) {
          workspace = { workspace:params[0], version:0, updated_at:'2026-08-26T01:00:00.000Z' };
          return { rowCount:1, rows:[workspace] };
        }
        if (sql.includes('DELETE FROM admin_public_objects')) { publicObjectsDeleted=true; return { rowCount:1, rows:[] }; }
        throw new Error(`Unexpected transaction SQL: ${sql}`);
      }};
      return work(client);
    }
  };
}

test('workspace reset requires CSRF and atomically increments version', async (t) => {
  const config = loadConfig({ NODE_ENV:'test', DATABASE_URL:'postgres://unused', AUTH_MODE:'local', ADMIN_PASSWORD_HASH:hashPassword('secret'), SESSION_COOKIE_SECURE:'false', CORS_ORIGINS:'http://localhost:4173', LOG_LEVEL:'silent' });
  const db = makeDb();
  const app = await buildApp({ config, db });
  t.after(() => app.close());

  const login = await app.inject({ method:'POST', url:'/api/auth/login', payload:{ username:'admin', password:'secret' } });
  assert.equal(login.statusCode, 200);
  const cookies = [].concat(login.headers['set-cookie'] || []).map((value) => value.split(';')[0]).join('; ');
  const csrf = cookies.match(/reliacode_csrf=([^;]+)/)[1];
  const denied = await app.inject({ method:'POST', url:'/api/v1/workspace/reset', headers:{ cookie:cookies }, payload:{ version:3 } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, 'CSRF_INVALID');

  const reset = await app.inject({ method:'POST', url:'/api/v1/workspace/reset', headers:{ cookie:cookies, 'x-csrf-token':csrf }, payload:{ version:3 } });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().version, 4);
  assert.equal(reset.json().workspace.initialized, false);
  assert.deepEqual(reset.json().workspace.accounts, []);
  assert.equal(db.publicObjectsDeleted, true);

  const conflict = await app.inject({ method:'POST', url:'/api/v1/workspace/reset', headers:{ cookie:cookies, 'x-csrf-token':csrf }, payload:{ version:3 } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, 'WORKSPACE_VERSION_CONFLICT');
});
