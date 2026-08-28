import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.mjs';
import { hashPassword, verifyPassword } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';

function makeDb() {
  const users=[];
  const organizations=[];
  const memberships=[];
  const sessions=new Map();
  return {
    users,
    async query(sql,params=[]) {
      if (sql.includes('INSERT INTO local_users')) {
        if (users.some((user)=>user.normalized_username===params[2]||user.normalized_email===params[4])) return { rowCount:0,rows:[] };
        const user={ id:params[0],username:params[1],normalized_username:params[2],email:params[3],normalized_email:params[4],password_hash:params[5],tenant_id:params[6],organization_id:params[7],role:'BRAND_ADMIN',status:'ACTIVE' };
        users.push(user);return { rowCount:1,rows:[user] };
      }
      if (sql.includes('INSERT INTO tenants') || sql.includes('INSERT INTO organizations') || sql.includes('INSERT INTO tenant_settings')) return { rowCount:1,rows:[] };
      if (sql.includes('INSERT INTO local_organizations')) { organizations.push({ id:params[0], tenant_id:params[1], name:params[2], owner_user_id:params[3], status:'ACTIVE' }); return { rowCount:1,rows:[] }; }
      if (sql.includes('INSERT INTO local_memberships')) { memberships.push({ id:params[0],user_id:params[1],organization_id:params[2],role:params[3],status:'ACTIVE' }); return { rowCount:1,rows:[] }; }
      if (sql.includes('SELECT id,username,email,password_hash') && sql.includes('FROM local_users')) {
        const user=users.find((item)=>item.normalized_username===params[0]||item.normalized_email===params[0]);
        return user ? { rowCount:1,rows:[user] } : { rowCount:0,rows:[] };
      }
      if (sql.includes('SELECT id,username,email,tenant_id,organization_id,role FROM local_users')) {
        const user=users.find((item)=>item.id===params[0]&&item.status==='ACTIVE');
        return user ? { rowCount:1,rows:[user] } : { rowCount:0,rows:[] };
      }
      if (sql.includes('FROM local_memberships m JOIN local_organizations')) {
        const membership=memberships.find((item)=>item.user_id===params[0]&&item.status==='ACTIVE');
        const organization=organizations.find((item)=>item.id===membership?.organization_id);
        return membership ? { rowCount:1,rows:[{ organization_id:membership.organization_id,role:membership.role,organization_name:organization?.name||'ReliaCode' }] } : { rowCount:0,rows:[] };
      }
      if (sql.includes('DELETE FROM admin_sessions')) return { rowCount:0,rows:[] };
      if (sql.includes('INSERT INTO admin_sessions')) { sessions.set(params[0],{ token_hash:params[0],csrf_token_hash:params[1],user_id:params[2],expires_at:new Date(Date.now()+3600000) }); return { rowCount:1,rows:[] }; }
      if (sql.includes('FROM admin_sessions WHERE token_hash=$1')) { const session=sessions.get(params[0]); return session ? { rowCount:1,rows:[session] } : { rowCount:0,rows:[] }; }
      if (sql.includes('FROM local_organization_workspaces')) return { rowCount:0,rows:[] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

test('registration hashes passwords, rejects duplicates and creates an authenticated user session', async(t)=>{
  const config=loadConfig({ NODE_ENV:'test',DATABASE_URL:'postgres://unused',AUTH_MODE:'local',ADMIN_PASSWORD_HASH:hashPassword('legacy-secret'),SESSION_COOKIE_SECURE:'false',LOG_LEVEL:'silent' });
  const db=makeDb();const app=await buildApp({config,db});t.after(()=>app.close());
  const created=await app.inject({method:'POST',url:'/api/auth/register',payload:{username:'alice_01',email:'Alice@example.com',password:'securepass123'}});
  assert.equal(created.statusCode,201);assert.equal(created.json().user.name,'alice_01');assert.equal(db.users.length,1);
  assert.notEqual(db.users[0].password_hash,'securepass123');assert.equal(verifyPassword('securepass123',db.users[0].password_hash),true);
  const cookies=[].concat(created.headers['set-cookie']||[]).map((value)=>value.split(';')[0]).join('; ');
  const session=await app.inject({method:'GET',url:'/api/auth/session',headers:{cookie:cookies}});
  assert.equal(session.statusCode,200);assert.equal(session.json().user.name,'alice_01');
  const duplicate=await app.inject({method:'POST',url:'/api/auth/register',payload:{username:'other',email:'alice@example.com',password:'securepass123'}});
  assert.equal(duplicate.statusCode,409);assert.equal(duplicate.json().code,'ACCOUNT_EXISTS');
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'ALICE@EXAMPLE.COM',password:'securepass123'}});
  assert.equal(login.statusCode,200);assert.equal(login.json().user.name,'alice_01');
});

test('registration validates username, email and password strength',async(t)=>{
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgres://unused',AUTH_MODE:'local',ADMIN_PASSWORD_HASH:hashPassword('legacy-secret'),SESSION_COOKIE_SECURE:'false',LOG_LEVEL:'silent'});
  const app=await buildApp({config,db:makeDb()});t.after(()=>app.close());
  const response=await app.inject({method:'POST',url:'/api/auth/register',payload:{username:'x!',email:'bad',password:'short'}});
  assert.equal(response.statusCode,400);assert.equal(response.json().code,'VALIDATION_ERROR');
});
