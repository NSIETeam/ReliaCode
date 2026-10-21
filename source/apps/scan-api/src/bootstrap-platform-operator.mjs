import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { hashPassword } from './auth.mjs';

const inputSchema = z.object({
  username:z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u),
  email:z.string().trim().email().max(254),
  password:z.string().min(16).max(200).refine((value)=>/\p{L}/u.test(value)&&/\p{N}/u.test(value)&&/[^\p{L}\p{N}]/u.test(value),'Password must contain a letter, number, and symbol'),
  tenantId:z.string().uuid(),
  organizationId:z.string().uuid()
}).strict();

export async function configurePlatformBootstrapContext(client) {
  await client.query("SELECT set_config('reliacode.tenant_id','',true),set_config('reliacode.system_access','on',true)");
}

export async function bootstrapPlatformOperator(client, rawInput) {
  const input = inputSchema.parse(rawInput);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('reliacode-platform-bootstrap'))");
  const existing = await client.query("SELECT id FROM local_users WHERE role='PLATFORM_OPERATOR' AND status='ACTIVE' LIMIT 1");
  if (existing.rowCount) throw new Error('An active platform operator already exists; bootstrap is single-use');
  await client.query(`INSERT INTO tenants(id,name,status,plan,approved_at,is_platform) VALUES($1,'ReliaCode Platform','ACTIVE','enterprise',now(),true) ON CONFLICT(id) DO NOTHING`,[input.tenantId]);
  const platformTenant=await client.query('SELECT id FROM tenants WHERE id=$1 AND is_platform=true',[input.tenantId]);
  if(!platformTenant.rowCount)throw new Error('Configured platform tenant ID is already used by a customer tenant');
  await client.query(`INSERT INTO organizations(id,tenant_id,type,name) VALUES($1,$2,'BRAND','ReliaCode Platform') ON CONFLICT(id) DO NOTHING`,[input.organizationId,input.tenantId]);
  const platformOrganization=await client.query('SELECT id FROM organizations WHERE id=$1 AND tenant_id=$2',[input.organizationId,input.tenantId]);
  if(!platformOrganization.rowCount)throw new Error('Configured platform organization ID is already in use');
  await client.query(`INSERT INTO local_organizations(id,tenant_id,name) VALUES($1,$2,'ReliaCode Platform') ON CONFLICT(id) DO NOTHING`,[input.organizationId,input.tenantId]);
  const userId=randomUUID(),membershipId=randomUUID(),normalizedUsername=input.username.toLowerCase(),normalizedEmail=input.email.toLowerCase();
  const created=await client.query(`INSERT INTO local_users(id,username,normalized_username,email,normalized_email,password_hash,tenant_id,organization_id,role)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PLATFORM_OPERATOR') RETURNING id,username,email,role`,[userId,input.username,normalizedUsername,input.email,normalizedEmail,hashPassword(input.password),input.tenantId,input.organizationId]);
  await client.query("INSERT INTO local_memberships(id,user_id,organization_id,role) VALUES($1,$2,$3,'PLATFORM_OPERATOR')",[membershipId,userId,input.organizationId]);
  await client.query('UPDATE local_organizations SET owner_user_id=$1 WHERE id=$2',[userId,input.organizationId]);
  await client.query(`INSERT INTO platform_audit_log(actor_id,action,entity_type,entity_id,reason,request_id,after_state)
    VALUES('bootstrap-cli','PLATFORM_OPERATOR_BOOTSTRAPPED','LOCAL_USER',$1,'Initial platform operator provisioning',$2,$3)`,[userId,randomUUID(),{username:input.username,email:normalizedEmail,role:'PLATFORM_OPERATOR'}]);
  return created.rows[0];
}

async function main() {
  const databaseFile=process.env.MIGRATION_DATABASE_URL_FILE;
  const passwordFile=process.env.PLATFORM_BOOTSTRAP_PASSWORD_FILE;
  if(!databaseFile||!passwordFile)throw new Error('MIGRATION_DATABASE_URL_FILE and PLATFORM_BOOTSTRAP_PASSWORD_FILE are required');
  const databaseUrl=readFileSync(databaseFile,'utf8').trim();
  let password=readFileSync(passwordFile,'utf8');
  password=password.endsWith('\n')?password.slice(0,-1):password;
  if(/[\r\n]/.test(password))throw new Error('Bootstrap password file must contain exactly one line');
  const client=new pg.Client({connectionString:databaseUrl,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:false});
  await client.connect();
  try {
    await client.query('BEGIN');
    await configurePlatformBootstrapContext(client);
    const user=await bootstrapPlatformOperator(client,{username:process.env.PLATFORM_BOOTSTRAP_USERNAME,email:process.env.PLATFORM_BOOTSTRAP_EMAIL,password,tenantId:process.env.ADMIN_TENANT_ID||'019d0000-0000-7000-8000-000000000001',organizationId:process.env.ADMIN_ORGANIZATION_ID||'019d0000-0000-7000-8000-000000000002'});
    await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify({created:true,userId:user.id,username:user.username,role:user.role})}\n`);
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().catch((error)=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
