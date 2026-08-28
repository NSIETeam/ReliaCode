import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { hashPassword, hashToken, newSessionToken, readCookie, verifyPassword, requireCapability, requireAnyCapability, ROLE_CAPABILITIES, ROLES } from "./auth.mjs";
import { eventCapability, nextObjectStatus, verificationForEvent } from "./domain.mjs";
import { getIdempotentResponse, lockIdempotencyKey, requestHash, saveIdempotentResponse } from "./idempotency.mjs";
import { codeBatchSchema, parseIdempotencyKey, riskDecisionSchema, traceEventSchema } from "./schemas.mjs";
import { evaluateEntitlements, getPlan } from "./entitlements.mjs";
import { enqueueWebhookDeliveries } from "./webhooks.mjs";
import { createLocalSession,rotateLocalSession,sessionCookies } from "./session-security.mjs";
import { authorizeOperationalDevice } from "./device-authorization.mjs";

function audit(client, request, action, entityType, entityId, beforeState, afterState) {
  const principal = request.principal;
  return client.query(
    `INSERT INTO audit_log(tenant_id,actor_id,actor_role,organization_id,action,entity_type,entity_id,request_id,before_state,after_state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [principal.tenantId, principal.id, principal.role, principal.organizationId, action, entityType, String(entityId), request.id, beforeState, afterState]
  );
}

function serial(prefix, rule, batchId, index) {
  if (rule === "SEQUENTIAL") return `${prefix}-${batchId.replaceAll("-", "").slice(0, 10).toUpperCase()}-${String(index + 1).padStart(8, "0")}`;
  return `${prefix}-${randomBytes(10).toString("hex").toUpperCase()}`;
}

function campaignScopeMatches(scope, object, principal) {
  const skuIds = Array.isArray(scope?.productIds) ? scope.productIds : [];
  const organizationIds = Array.isArray(scope?.organizationIds) ? scope.organizationIds : [];
  return (!skuIds.length || skuIds.includes(object.product_id)) &&
    (!organizationIds.length || organizationIds.includes(principal.organizationId));
}

const workspaceStateSchema = z.object({
  schemaVersion:z.literal(1),
  initialized:z.boolean(),
  workspace:z.object({ id:z.string().uuid(), brandName:z.string().min(1).max(160), createdAt:z.string().max(80) }).passthrough(),
  accounts:z.array(z.record(z.string(), z.unknown())).max(100),
  currentAccountId:z.string().uuid().nullable(),
  products:z.array(z.record(z.string(), z.unknown())).max(10000),
  codeBatches:z.array(z.record(z.string(), z.unknown())).max(10000),
  objects:z.record(z.string(), z.object({
    code:z.string().min(1).max(200),
    publicId:z.string().uuid(),
    level:z.enum(['ITEM','CASE','PALLET']),
    lot:z.string().max(200).nullable().optional(),
    status:z.string().min(1).max(40),
    productId:z.string().uuid(),
    createdAt:z.string().max(80)
  }).passthrough()).superRefine((value, ctx) => {
    if (Object.keys(value).length > 10000) ctx.addIssue({ code:'custom', message:'objects limit exceeded' });
  }),
  events:z.array(z.record(z.string(), z.unknown())).max(50000),
  campaigns:z.array(z.record(z.string(), z.unknown())).max(10000),
  ledger:z.array(z.record(z.string(), z.unknown())).max(50000),
  risks:z.array(z.record(z.string(), z.unknown())).max(50000),
  agentRuns:z.array(z.record(z.string(), z.unknown())).max(50000)
}).strict();

export function parseWorkspace(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { const error = new Error('Workspace payload must be valid JSON'); error.statusCode=400; error.code='WORKSPACE_INVALID'; throw error; }
  if (serialized === undefined || serialized === 'null') { const error = new Error('Workspace payload must be a JSON object'); error.statusCode=400; error.code='WORKSPACE_INVALID'; throw error; }
  if (serialized.length > 4 * 1024 * 1024) {
    const error = new Error('Workspace exceeds 4 MiB limit'); error.statusCode=413; error.code='WORKSPACE_TOO_LARGE'; throw error;
  }
  try {
    return workspaceStateSchema.parse(value);
  } catch (error) {
    if (error?.name === 'ZodError') { error.statusCode=400; error.code='VALIDATION_ERROR'; }
    throw error;
  }
}

function emptyWorkspaceState() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const id = bytes.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  return {
    schemaVersion:1,
    initialized:false,
    workspace:{ id, brandName:'ReliaCode', createdAt:new Date().toISOString() },
    accounts:[], currentAccountId:null, products:[], codeBatches:[], objects:{},
    events:[], campaigns:[], ledger:[], risks:[], agentRuns:[]
  };
}

async function syncPublicProjection(client, state, ownerUserId=null) {
  if (ownerUserId) await client.query(`DELETE FROM admin_public_objects WHERE owner_user_id=$1 OR owner_user_id IN (
    SELECT m.user_id FROM local_memberships m WHERE m.organization_id=(SELECT organization_id FROM local_memberships WHERE user_id=$1 AND status='ACTIVE' LIMIT 1)
  )`, [ownerUserId]);
  else await client.query('DELETE FROM admin_public_objects WHERE owner_user_id IS NULL');
  const products = new Map(state.products.map((item) => [String(item.id), item]));
  const eventsByCode = new Map();
  for (const event of state.events) {
    if (!event.code || !event.time) continue;
    const list = eventsByCode.get(String(event.code).toUpperCase()) || [];
    if (list.length < 20) list.push({ type:String(event.action || 'VERIFY'), time:String(event.time) });
    eventsByCode.set(String(event.code).toUpperCase(), list);
  }
  for (const object of Object.values(state.objects)) {
    const product = products.get(String(object.productId));
    if (!product) continue;
    await client.query(
      'INSERT INTO admin_public_objects(public_id,code,level,lot,status,commissioned_at,product_name,gtin,events,owner_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)',
      [object.publicId, object.code, object.level, object.lot || null, object.status, object.createdAt, String(product.name || 'Product'), product.gtin || null, JSON.stringify(eventsByCode.get(String(object.code).toUpperCase()) || []), ownerUserId]
    );
  }
}

function normalized(value) { return String(value).trim().toLocaleLowerCase('en-US'); }
const roleSchema = z.enum(ROLES);
const emailSchema = z.string().trim().email().max(254).transform(normalized);
async function inTransaction(db, work) { return typeof db.transaction === 'function' ? db.transaction(work) : work(db); }
export async function changeMemberAccountStatus(client,{tenantId,organizationId,userId,actorId,status,reason}){const found=await client.query(`SELECT u.id,u.status,o.owner_user_id FROM local_users u JOIN local_memberships m ON m.user_id=u.id JOIN local_organizations o ON o.id=m.organization_id
  WHERE u.tenant_id=$1 AND m.organization_id=$2 AND u.id=$3 AND m.status='ACTIVE' FOR UPDATE OF u`,[tenantId,organizationId,userId]);if(!found.rowCount){const error=new Error("Member not found");error.statusCode=404;error.code="MEMBER_NOT_FOUND";throw error;}if(found.rows[0].owner_user_id===userId){const error=new Error("The tenant owner account cannot be frozen");error.statusCode=409;error.code="OWNER_FREEZE_FORBIDDEN";throw error;}const changed=await client.query("UPDATE local_users SET status=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3 RETURNING id,status",[status,userId,tenantId]);if(status==="DISABLED")await client.query("UPDATE admin_sessions SET revoked_at=now(),revoked_by=$1,revocation_reason=$2 WHERE user_id=$3 AND revoked_at IS NULL",[actorId,reason,userId]);await client.query(`INSERT INTO authentication_events(tenant_id,user_id,event_type,risk_level,actor_id,reason) VALUES($1,$2,$3,'LOW',$4,$5)`,[tenantId,userId,status==="DISABLED"?"ACCOUNT_FROZEN":"ACCOUNT_UNFROZEN",actorId,reason]);return{before:found.rows[0],after:changed.rows[0]};}
function requireOrganizationAdmin(principal) {
  if (principal?.role !== 'BRAND_ADMIN') {
    const error = new Error('Organization administrator permission is required');
    error.statusCode = 403;
    error.code = 'FORBIDDEN';
    throw error;
  }
}
function sessionUser(principal) {
  return {
    id:principal.id, name:principal.name, email:principal.email || null, role:principal.role,
    capabilities:[...principal.capabilities], tenantId:principal.tenantId,
    organizationId:principal.organizationId, organizationName:principal.organizationName || null
  };
}

async function createRewardForEvent(client, { request, event, object, idempotencyKey }) {
  const candidates = await client.query(
    `SELECT c.id campaign_id,c.code,c.name,c.budget_points,cv.id campaign_version_id,cv.version,cv.reward_points,cv.hold_days,cv.monthly_cap_points,cv.scope
     FROM campaigns c JOIN campaign_versions cv ON cv.campaign_id=c.id
     WHERE c.tenant_id=$1 AND c.status='ACTIVE' AND $2::timestamptz BETWEEN c.starts_at AND c.ends_at
       AND cv.trigger_type=$3 AND cv.published_at IS NOT NULL
       AND cv.version=(SELECT max(v2.version) FROM campaign_versions v2 WHERE v2.campaign_id=c.id AND v2.published_at IS NOT NULL)`,
    [request.principal.tenantId, event.event_time, event.event_type]
  );
  const matching = candidates.rows.filter((candidate) => campaignScopeMatches(candidate.scope, object, request.principal));
  if (!matching.length) return { claim:null, ledgerEntry:null, reason:"NO_MATCHING_CAMPAIGN" };
  if (matching.length > 1) return { claim:null, ledgerEntry:null, reason:"AMBIGUOUS_CAMPAIGN" };
  const campaign = matching[0];
  const spent = await client.query(
    `SELECT COALESCE(sum(rc.amount_points),0)::bigint spent FROM reward_claims rc
     JOIN campaign_versions cv ON cv.id=rc.campaign_version_id
     WHERE cv.campaign_id=$1 AND rc.status NOT IN ('REJECTED','REVERSED')`,
    [campaign.campaign_id]
  );
  if (BigInt(spent.rows[0].spent) + BigInt(campaign.reward_points) > BigInt(campaign.budget_points)) {
    return { claim:null, ledgerEntry:null, reason:"CAMPAIGN_BUDGET_EXHAUSTED" };
  }
  const monthly = await client.query(
    `SELECT COALESCE(sum(amount_points),0)::bigint awarded FROM reward_claims
     WHERE tenant_id=$1 AND campaign_version_id=$2 AND beneficiary_organization_id=$3
       AND created_at>=date_trunc('month',$4::timestamptz) AND created_at<date_trunc('month',$4::timestamptz)+interval '1 month'
       AND status NOT IN ('REJECTED','REVERSED')`,
    [request.principal.tenantId,campaign.campaign_version_id,request.principal.organizationId,event.event_time]
  );
  if (BigInt(monthly.rows[0].awarded) + BigInt(campaign.reward_points) > BigInt(campaign.monthly_cap_points)) {
    return { claim:null, ledgerEntry:null, reason:"BENEFICIARY_MONTHLY_CAP_REACHED" };
  }
  const claimResult = await client.query(
    `INSERT INTO reward_claims(tenant_id,trace_event_id,campaign_version_id,beneficiary_organization_id,amount_points,status)
     VALUES($1,$2,$3,$4,$5,'HELD') ON CONFLICT DO NOTHING RETURNING *`,
    [request.principal.tenantId,event.id,campaign.campaign_version_id,request.principal.organizationId,campaign.reward_points]
  );
  if (!claimResult.rowCount) return { claim:null, ledgerEntry:null, reason:"ALREADY_CLAIMED" };
  const availableAt = new Date(new Date(event.event_time).getTime() + campaign.hold_days * 86_400_000).toISOString();
  const ledgerResult = await client.query(
    `INSERT INTO ledger_entries(tenant_id,claim_id,beneficiary_organization_id,entry_type,amount_points,available_at,idempotency_key)
     VALUES($1,$2,$3,'ACCRUAL',$4,$5,$6) RETURNING *`,
    [request.principal.tenantId,claimResult.rows[0].id,request.principal.organizationId,campaign.reward_points,availableAt,`${idempotencyKey}:reward`]
  );
  return { claim:claimResult.rows[0], ledgerEntry:ledgerResult.rows[0], reason:"REWARD_HELD", campaign:{ id:campaign.campaign_id, code:campaign.code, version:campaign.version } };
}

export function registerRoutes(app, { db, config, loginAttempts }) {
  app.post('/api/v1/organization/invitations', async (request, reply) => {
    if (config.AUTH_MODE !== 'local') return reply.code(404).send({ code:'NOT_FOUND', message:'Route not found' });
    requireCapability(request.principal, 'members:invite');
    if (request.principal.id === 'local-admin') return reply.code(403).send({ code:'MEMBERSHIP_REQUIRED', message:'A local user membership is required to invite members' });
    const body=z.object({
      email:z.string().trim().email().max(254).optional(),
      role:roleSchema,
      expiresInHours:z.coerce.number().int().min(1).max(720).default(168)
    }).strict().parse(request.body || {});
    const token=newSessionToken(), invitationId=randomUUID(), expiresAt=new Date(Date.now()+body.expiresInHours*3_600_000);
    const email=body.email ? normalized(body.email) : null;
    const organization=await db.query('SELECT id,name,status FROM local_organizations WHERE id=$1 AND status=\'ACTIVE\'', [request.principal.organizationId]);
    if (!organization.rowCount) return reply.code(404).send({ code:'ORGANIZATION_NOT_FOUND', message:'Organization is not available' });
    await db.query(
      `INSERT INTO local_invitations(id,organization_id,invited_by_user_id,email,role,token_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [invitationId,request.principal.organizationId,request.principal.id,email,body.role,hashToken(token),expiresAt.toISOString()]
    );
    // The raw token is returned exactly once. Its hash is never included in a
    // response or log and is only useful for the one-time accept operation.
    return reply.code(201).send({ invitation:{ id:invitationId,email,role:body.role,expiresAt:expiresAt.toISOString(),organization:{ id:organization.rows[0].id,name:organization.rows[0].name } }, token });
  });

  app.get('/api/v1/organization/invitations', async (request, reply) => {
    if (config.AUTH_MODE !== 'local') return reply.code(404).send({ code:'NOT_FOUND', message:'Route not found' });
    requireAnyCapability(request.principal, ['members:read','members:invite']);
    const result=await db.query(
      `SELECT id,email,role,expires_at,accepted_at,revoked_at,created_at
       FROM local_invitations WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [request.principal.organizationId]
    );
    return { invitations:result.rows.map((row)=>({ id:row.id,email:row.email,role:row.role,expiresAt:row.expires_at,acceptedAt:row.accepted_at,revokedAt:row.revoked_at,createdAt:row.created_at })) };
  });

  app.delete('/api/v1/organization/invitations/:id', async (request, reply) => {
    if (config.AUTH_MODE !== 'local') return reply.code(404).send({ code:'NOT_FOUND', message:'Route not found' });
    requireCapability(request.principal, 'members:invite');
    const id=z.string().uuid().parse(request.params.id);
    const result=await db.query(
      `UPDATE local_invitations SET revoked_at=now()
       WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL
       RETURNING id,revoked_at`,
      [id,request.principal.organizationId]
    );
    if (!result.rowCount) return reply.code(404).send({ code:'INVITATION_NOT_FOUND', message:'Invitation is missing or no longer active' });
    return { revoked:true, invitation:{ id:result.rows[0].id,revokedAt:result.rows[0].revoked_at } };
  });

  app.get('/api/v1/organization/members', async (request, reply) => {
    if (config.AUTH_MODE !== 'local') return reply.code(404).send({ code:'NOT_FOUND', message:'Route not found' });
    requireAnyCapability(request.principal, ['members:read','members:invite']);
    const result=await db.query(
      `SELECT u.id,u.username,u.email,m.role,m.status,m.created_at,o.name organization_name
       FROM local_memberships m JOIN local_users u ON u.id=m.user_id
       JOIN local_organizations o ON o.id=m.organization_id
       WHERE m.organization_id=$1 ORDER BY m.created_at ASC`,
      [request.principal.organizationId]
    );
    return { members:result.rows.map((row)=>({ id:row.id,name:row.username,email:row.email,role:row.role,status:row.status,createdAt:row.created_at,organizationName:row.organization_name })) };
  });

  app.patch('/api/v1/organization/members/:userId', async (request, reply) => {
    if (config.AUTH_MODE !== 'local') return reply.code(404).send({ code:'NOT_FOUND', message:'Route not found' });
    requireCapability(request.principal, 'members:manage');
    const userId=z.string().uuid().parse(request.params.userId);
    const body=z.object({ role:roleSchema }).strict().parse(request.body);
    if (userId===request.principal.id && body.role!=='BRAND_ADMIN') return reply.code(409).send({ code:'OWNER_ROLE_REQUIRED', message:'The organization owner must remain a brand admin' });
    const current=await db.query(
      `SELECT m.user_id,m.role,m.status,o.owner_user_id FROM local_memberships m JOIN local_organizations o ON o.id=m.organization_id
       WHERE m.organization_id=$1 AND m.user_id=$2`,
      [request.principal.organizationId,userId]
    );
    if (!current.rowCount || current.rows[0].status!=='ACTIVE') return reply.code(404).send({ code:'MEMBER_NOT_FOUND', message:'Member is not active' });
    if (current.rows[0].owner_user_id===userId && body.role!=='BRAND_ADMIN') return reply.code(409).send({ code:'OWNER_ROLE_REQUIRED', message:'The organization owner must remain a brand admin' });
    if (current.rows[0].role==='BRAND_ADMIN' && body.role!=='BRAND_ADMIN') {
      const admins=await db.query(`SELECT count(*)::int count FROM local_memberships WHERE organization_id=$1 AND status='ACTIVE' AND role='BRAND_ADMIN'`,[request.principal.organizationId]);
      if (Number(admins.rows[0]?.count||0)<=1) return reply.code(409).send({ code:'LAST_ADMIN', message:'The organization must retain a brand admin' });
    }
    const updated=await inTransaction(db, async (client)=>{
      const membership=await client.query(`UPDATE local_memberships SET role=$1,updated_at=now() WHERE organization_id=$2 AND user_id=$3 RETURNING user_id,role,status`,[body.role,request.principal.organizationId,userId]);
      await client.query(`UPDATE local_users SET role=$1,updated_at=now() WHERE id=$2 AND organization_id=$3`,[body.role,userId,request.principal.organizationId]);
      return membership.rows[0];
    });
    return { member:{ id:updated.user_id,role:updated.role,status:updated.status } };
  });

  app.post('/api/v1/organization/members/:userId/account-status',async(request,reply)=>{if(config.AUTH_MODE!=="local")return reply.code(404).send({code:"NOT_FOUND",message:"Route not found"});requireCapability(request.principal,"members:manage");const userId=z.string().uuid().parse(request.params.userId),body=z.object({status:z.enum(["ACTIVE","DISABLED"]),auditReason:z.string().trim().min(3).max(500)}).parse(request.body);if(userId===request.principal.id)return reply.code(409).send({code:"SELF_FREEZE_FORBIDDEN",message:"Administrators cannot change their own account status"});const key=parseIdempotencyKey(request),operation="MEMBER_ACCOUNT_STATUS",hash=requestHash(operation,{userId,...body});const response=await inTransaction(db,async client=>{await lockIdempotencyKey(client,request.principal.tenantId,key);const cached=await getIdempotentResponse(client,request.principal.tenantId,key,hash);if(cached)return cached;const changed=await changeMemberAccountStatus(client,{tenantId:request.principal.tenantId,organizationId:request.principal.organizationId,userId,actorId:request.principal.id,status:body.status,reason:body.auditReason});await audit(client,request,body.status==="DISABLED"?"MEMBER_ACCOUNT_FROZEN":"MEMBER_ACCOUNT_UNFROZEN","LOCAL_USER",userId,changed.before,changed.after);const value={member:changed.after};await saveIdempotentResponse(client,{tenantId:request.principal.tenantId,key,operation,hash,status:200,body:value});return{status:200,body:value};});return reply.code(response.status).send(response.body);});

  app.get('/api/v1/security/authentication-events',async(request)=>{requireCapability(request.principal,'members:manage');const query=z.object({riskLevel:z.enum(['LOW','MEDIUM','HIGH']).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(request.query);const result=await db.query(`SELECT e.id,e.user_id,u.username,e.event_type,e.auth_method,e.risk_level,e.user_agent,e.actor_id,e.reason,e.metadata,e.created_at
    FROM authentication_events e LEFT JOIN local_users u ON u.id=e.user_id AND u.tenant_id=e.tenant_id
    WHERE e.tenant_id=$1 AND ($2::text IS NULL OR e.risk_level=$2) ORDER BY e.created_at DESC,e.id DESC LIMIT $3`,[request.principal.tenantId,query.riskLevel||null,query.limit]);return{items:result.rows};});

  app.post('/api/auth/invitations/accept', async (request, reply) => {
    if (config.AUTH_MODE !== 'local') return reply.code(404).send({ code:'NOT_FOUND', message:'Route not found' });
    const body=z.object({
      token:z.string().trim().min(20).max(200),
      username:z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u).optional(),
      email:z.string().trim().email().max(254).optional(),
      password:z.string().min(10).max(200).refine((value)=>/\p{L}/u.test(value)&&/\p{N}/u.test(value),'Password must contain at least one letter and one number').optional()
    }).strict().parse(request.body);
    const authenticated=Boolean(request.principal);
    if (!authenticated && (!body.username || !body.email || !body.password)) return reply.code(400).send({ code:'INVITATION_ACCOUNT_REQUIRED', message:'Username, email and password are required for a new invited account' });
    if (authenticated && (body.username || body.email || body.password)) return reply.code(400).send({ code:'INVITATION_ACCOUNT_CONFLICT', message:'An authenticated member must not submit new account credentials' });
    const result=await inTransaction(db, async (client)=>{
      const invite=await client.query(
        `SELECT i.id,i.organization_id,i.invited_by_user_id,i.email,i.role,i.expires_at,o.tenant_id,o.name organization_name
         FROM local_invitations i JOIN local_organizations o ON o.id=i.organization_id
         WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND o.status='ACTIVE' FOR UPDATE`,
        [hashToken(body.token)]
      );
      if (!invite.rowCount) return { error:{ status:404,code:'INVITATION_INVALID',message:'Invitation is invalid, expired or revoked' } };
      const invitation=invite.rows[0];
      if (invitation.email && normalized(body.email || request.principal?.email || '')!==invitation.email) return { error:{ status:403,code:'INVITATION_EMAIL_MISMATCH',message:'Invitation email does not match the account' } };
      let userId=request.principal?.id, username=request.principal?.name, email=request.principal?.email || invitation.email;
      if (userId) {
        const existing=await client.query(`SELECT organization_id FROM local_memberships WHERE user_id=$1 AND status='ACTIVE'`,[userId]);
        if (existing.rowCount) return { error:{ status:409,code:'ALREADY_MEMBER',message:'This account already belongs to an organization' } };
      } else {
        userId=randomUUID(); username=body.username.trim(); email=normalized(body.email);
        const inserted=await client.query(
          `INSERT INTO local_users(id,username,normalized_username,email,normalized_email,password_hash,tenant_id,organization_id,role)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id,username,email,role`,
          [userId,username,normalized(username),email,email,hashPassword(body.password),invitation.tenant_id,invitation.organization_id,invitation.role]
        );
        if (!inserted.rowCount) return { error:{ status:409,code:'ACCOUNT_EXISTS',message:'Username or email is already registered' } };
      }
      await client.query('INSERT INTO local_memberships(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)',[randomUUID(),userId,invitation.organization_id,invitation.role]);
      await client.query('UPDATE local_invitations SET accepted_at=now() WHERE id=$1',[invitation.id]);
      return { user:{ id:userId,name:username,email,role:invitation.role,capabilities:ROLE_CAPABILITIES[invitation.role],tenantId:invitation.tenant_id,organizationId:invitation.organization_id,organizationName:invitation.organization_name } };
    });
    if (result.error) return reply.code(result.error.status).send({ code:result.error.code,message:result.error.message });
    const session=await createLocalSession(db,config,{userId:result.user.id,tenantId:result.user.tenantId,request,authMethod:"PASSWORD"});
    reply.header('set-cookie',sessionCookies(config,session.token,session.csrf));
    return { authenticated:true,csrfToken:session.csrf,user:result.user,invitationAccepted:true };
  });

  app.post('/api/auth/register',{config:{rateLimit:{max:10,timeWindow:'1 hour'}}}, async (request, reply) => {
    if (config.AUTH_MODE !== 'local' || !config.ALLOW_PUBLIC_REGISTRATION) return reply.code(404).send({ code:'NOT_FOUND', message:'Route not found' });
    const now=Date.now(), key='register:'+request.ip;
    const attempt=loginAttempts.get(key) || { count:0, resetAt:now+300000 };
    if (attempt.resetAt<=now) { attempt.count=0; attempt.resetAt=now+300000; }
    if (attempt.count>=5) return reply.code(429).send({ code:'REGISTER_RATE_LIMITED', message:'Too many registration attempts' });
    const body=z.object({
      username:z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u, 'Username may only contain letters, numbers, underscores and hyphens'),
      email:z.string().trim().email().max(254),
      password:z.string().min(10).max(200).refine((value)=>/\p{L}/u.test(value)&&/\p{N}/u.test(value), 'Password must contain at least one letter and one number'),
      organizationName:z.string().trim().min(1).max(160).optional()
    }).strict().parse(request.body);
    attempt.count+=1; loginAttempts.set(key,attempt);
    const user={ id:randomUUID(), tenantId:randomUUID(), organizationId:randomUUID(), username:body.username.trim(), email:body.email.trim() };
    const created=await inTransaction(db, async (client) => {
      const inserted=await client.query(
        `INSERT INTO local_users(id,username,normalized_username,email,normalized_email,password_hash,tenant_id,organization_id,role)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'BRAND_ADMIN') ON CONFLICT DO NOTHING RETURNING id,username,email,role`,
        [user.id,user.username,normalized(user.username),user.email,normalized(user.email),hashPassword(body.password),user.tenantId,user.organizationId]
      );
      if (!inserted.rowCount) return { duplicate:true };
      const organizationName=body.organizationName || `${user.username} Organization`;
      await client.query("INSERT INTO tenants(id,name,status,plan,approved_at) VALUES($1,$2,'ACTIVE','free',now())",[user.tenantId,organizationName]);
      await client.query("INSERT INTO organizations(id,tenant_id,type,name) VALUES($1,$2,'BRAND',$3)",[user.organizationId,user.tenantId,organizationName]);
      await client.query("INSERT INTO tenant_settings(tenant_id) VALUES($1)",[user.tenantId]);
      await client.query('INSERT INTO local_organizations(id,tenant_id,name,owner_user_id) VALUES($1,$2,$3,$4)',[user.organizationId,user.tenantId,organizationName,user.id]);
      await client.query('INSERT INTO local_memberships(id,user_id,organization_id,role) VALUES($1,$2,$3,$4)',[randomUUID(),user.id,user.organizationId,'BRAND_ADMIN']);
      return { duplicate:false, organizationName };
    });
    if (created.duplicate) return reply.code(409).send({ code:'ACCOUNT_EXISTS', message:'Username or email is already registered' });
    loginAttempts.delete(key);
    const session=await createLocalSession(db,config,{userId:user.id,tenantId:user.tenantId,request,authMethod:"PASSWORD"});
    reply.header('set-cookie',sessionCookies(config,session.token,session.csrf));
    return reply.code(201).send({ authenticated:true,csrfToken:session.csrf,user:{ id:user.id,name:user.username,email:user.email,role:'BRAND_ADMIN',capabilities:ROLE_CAPABILITIES.BRAND_ADMIN,tenantId:user.tenantId,organizationId:user.organizationId,organizationName:created.organizationName } });
  });

  app.post('/api/auth/login',{config:{rateLimit:{max:20,timeWindow:'5 minutes'}}}, async (request, reply) => {
    if (config.AUTH_MODE !== 'local') return reply.code(404).send({ code:'NOT_FOUND', message:'Route not found' });
    const now = Date.now();
    const key = request.ip;
    if (loginAttempts.size > 10000) for (const [ip, value] of loginAttempts) if (value.resetAt <= now) loginAttempts.delete(ip);
    const attempt = loginAttempts.get(key) || { count:0, resetAt:now + 300000 };
    if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 300000; }
    if (attempt.count >= 5) return reply.code(429).send({ code:'LOGIN_RATE_LIMITED', message:'Too many login attempts' });
    const body = z.object({ username:z.string().min(1).max(80), password:z.string().min(1).max(200) }).parse(request.body);
    const found=await db.query(`SELECT u.id,u.username,u.email,u.password_hash,u.tenant_id,u.organization_id,u.role,
      COALESCE(ts.password_login_for_operators,true) password_login_for_operators
      FROM local_users u LEFT JOIN tenant_settings ts ON ts.tenant_id=u.tenant_id
      WHERE (u.normalized_username=$1 OR u.normalized_email=$1) AND u.status='ACTIVE'`, [normalized(body.username)]);
    const user=found.rows[0] || null;
    const isLegacyAdmin=body.username===config.ADMIN_USERNAME && verifyPassword(body.password,config.ADMIN_PASSWORD_HASH);
    const operatorRoles=new Set(['FACTORY_OPERATOR','DISTRIBUTOR_RECEIVER','STORE_RECEIVER']);
    const passwordAllowed=!user||!operatorRoles.has(String(user.role).toUpperCase())||user.password_login_for_operators!==false;
    const passwordValid=user ? passwordAllowed&&verifyPassword(body.password,user.password_hash) : isLegacyAdmin;
    if (!passwordValid) {
      attempt.count += 1; loginAttempts.set(key, attempt);
      return reply.code(401).send({ code:'INVALID_CREDENTIALS', message:'Invalid username or password' });
    }
    loginAttempts.delete(key);
    const session=await createLocalSession(db,config,{userId:user?.id||null,tenantId:user?.tenant_id||config.ADMIN_TENANT_ID,request,authMethod:"PASSWORD"});
    reply.header('set-cookie',sessionCookies(config,session.token,session.csrf));
    const role=String(user?.role || 'PLATFORM_OPERATOR').toUpperCase();
    return { authenticated:true, csrfToken:session.csrf, riskLevel:session.riskLevel, user:{ id:user?.id || 'local-admin', name:user?.username || config.ADMIN_USERNAME, email:user?.email || null, role, capabilities:ROLE_CAPABILITIES[role] || ROLE_CAPABILITIES.PLATFORM_OPERATOR, tenantId:user?.tenant_id || config.ADMIN_TENANT_ID, organizationId:user?.organization_id || config.ADMIN_ORGANIZATION_ID } };
  });

  app.get('/api/auth/session', async (request, reply) => {
    if (config.AUTH_MODE !== 'local' || !request.principal) return reply.code(401).send({ authenticated:false });
    let csrfToken=readCookie(request.headers.cookie, config.CSRF_COOKIE_NAME);
    if (!csrfToken || hashToken(csrfToken) !== request.authSession.csrf_token_hash) {
      csrfToken=newSessionToken();
      await db.query('UPDATE admin_sessions SET csrf_token_hash=$1,last_seen_at=now() WHERE token_hash=$2', [hashToken(csrfToken), request.authSession.token_hash]);
      request.authSession.csrf_token_hash = hashToken(csrfToken);
      const secure = config.SESSION_COOKIE_SECURE ? '; Secure' : '';
      reply.header('set-cookie', config.CSRF_COOKIE_NAME + '=' + csrfToken + '; Path=/; SameSite=Strict; Max-Age=' + (config.SESSION_TTL_HOURS * 3600) + secure);
    }
    const rotated=await rotateLocalSession(db,config,request,reply);if(rotated)csrfToken=rotated.csrf;
    return { authenticated:true, csrfToken, user:sessionUser(request.principal) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.authSession?.token_hash) await inTransaction(db,async client=>{const revoked=await client.query("UPDATE admin_sessions SET revoked_at=now(),revoked_by=$2,revocation_reason='User logged out' WHERE token_hash=$1 AND revoked_at IS NULL RETURNING tenant_id,user_id",[request.authSession.token_hash,request.principal.id]);if(revoked.rows[0]?.user_id)await client.query(`INSERT INTO authentication_events(tenant_id,user_id,event_type,risk_level,actor_id,reason) VALUES($1,$2,'SESSION_REVOKED','LOW',$2,'User logged out')`,[revoked.rows[0].tenant_id,revoked.rows[0].user_id]);});
    const secure = config.SESSION_COOKIE_SECURE ? '; Secure' : '';
    reply.header('set-cookie', [config.SESSION_COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + secure, config.CSRF_COOKIE_NAME + '=; Path=/; SameSite=Strict; Max-Age=0' + secure]);
    return { authenticated:false };
  });

  app.get('/api/v1/organization/entitlements', async (request, reply) => {
    try {
      const current = await db.query(
        `SELECT COALESCE(e.plan, 'free') AS plan,
                COALESCE(u.member_count, 0)::int AS member_count,
                COALESCE(u.scan_count, 0)::int AS scan_count,
                COALESCE(u.code_count, 0)::int AS code_count
           FROM (SELECT $1::uuid AS tenant_id) t
           LEFT JOIN tenant_entitlements e ON e.tenant_id=t.tenant_id
           LEFT JOIN tenant_usage_monthly u ON u.tenant_id=t.tenant_id
             AND u.usage_month=date_trunc('month', now())::date`,
        [request.principal.tenantId]
      );
      const row = current.rows[0] || { plan: 'free', member_count: 0, scan_count: 0, code_count: 0 };
      const verdict = evaluateEntitlements({
        plan: row.plan,
        usage: { members: Number(row.member_count), monthlyScans: Number(row.scan_count), monthlyCodes: Number(row.code_count) }
      });
      return { tenantId: request.principal.tenantId, ...verdict };
    } catch (error) {
      if (error?.code === '42P01') return reply.code(503).send({ code: 'ENTITLEMENTS_UNAVAILABLE', message: 'Entitlement storage is not ready' });
      throw error;
    }
  });

  app.patch('/api/v1/organization/entitlements', async (request, reply) => {
    requireOrganizationAdmin(request.principal);
    const body = z.object({ plan: z.enum(['free', 'team']) }).strict().parse(request.body);
    const result = await inTransaction(db, async (client) => {
      const before = await client.query('SELECT plan FROM tenant_entitlements WHERE tenant_id=$1 FOR UPDATE', [request.principal.tenantId]);
      const previousPlan = before.rows[0]?.plan || 'free';
      const saved = await client.query(
        `INSERT INTO tenant_entitlements(tenant_id,plan,effective_at,updated_at)
         VALUES($1,$2,now(),now())
         ON CONFLICT(tenant_id) DO UPDATE SET plan=EXCLUDED.plan,effective_at=now(),updated_at=now()
         RETURNING tenant_id,plan,effective_at,updated_at`,
        [request.principal.tenantId, body.plan]
      );
      await client.query(
        `INSERT INTO tenant_entitlement_audit(tenant_id,actor_id,action,plan_before,plan_after,request_id)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [request.principal.tenantId, request.principal.id, previousPlan === body.plan ? 'PLAN_ASSIGNED' : 'PLAN_CHANGED', previousPlan, body.plan, request.id]
      );
      return saved.rows[0];
    });
    return { tenantId: result.tenant_id, plan: getPlan(result.plan), effectiveAt: result.effective_at, updatedAt: result.updated_at };
  });
  app.get('/api/v1/workspace', async (request, reply) => {
    const result = request.principal.id==='local-admin'
      ? await db.query('SELECT workspace,version,updated_at FROM admin_workspaces WHERE id=1')
      : await db.query('SELECT workspace,version,updated_at FROM local_organization_workspaces WHERE organization_id=$1',[request.principal.organizationId]);
    if (!result.rowCount) return reply.code(404).send({ code:'WORKSPACE_NOT_FOUND', message:'Workspace has not been initialized' });
    return { workspace:result.rows[0].workspace, version:Number(result.rows[0].version), updatedAt:result.rows[0].updated_at };
  });

  app.put('/api/v1/workspace', async (request, reply) => {
    if(request.principal.id!=='local-admin')requireAnyCapability(request.principal, ['codes:write','events:write:packing','events:write:distributor_receiving','events:write:store_receiving']);
    const body = z.object({ version:z.coerce.number().int().min(0), workspace:z.unknown() }).parse(request.body);
    const state = parseWorkspace(body.workspace);
    const result = await db.transaction(async (client) => {
      const legacy=request.principal.id==='local-admin';
      const saved = legacy
        ? await client.query('INSERT INTO admin_workspaces(id,workspace,version) VALUES(1,$1,0) ON CONFLICT(id) DO UPDATE SET workspace=EXCLUDED.workspace,version=admin_workspaces.version+1,updated_at=now() WHERE admin_workspaces.version=$2 RETURNING workspace,version,updated_at',[state,body.version])
        : await client.query('INSERT INTO local_organization_workspaces(organization_id,workspace,version) VALUES($1,$2,0) ON CONFLICT(organization_id) DO UPDATE SET workspace=EXCLUDED.workspace,version=local_organization_workspaces.version+1,updated_at=now() WHERE local_organization_workspaces.version=$3 RETURNING workspace,version,updated_at',[request.principal.organizationId,state,body.version]);
      if (!saved.rowCount) return { conflict:true, current:legacy ? await client.query('SELECT workspace,version,updated_at FROM admin_workspaces WHERE id=1') : await client.query('SELECT workspace,version,updated_at FROM local_organization_workspaces WHERE organization_id=$1',[request.principal.organizationId]) };
      if (config.AUTH_MODE === 'local') await syncPublicProjection(client, state, legacy ? null : request.principal.id);
      if (!legacy && request.principal.role === 'BRAND_ADMIN') await client.query('UPDATE local_organizations SET name=$1,updated_at=now() WHERE id=$2 AND status=\'ACTIVE\'', [state.workspace.brandName,request.principal.organizationId]);
      return { saved:saved.rows[0] };
    });
    if (result.conflict) {
      const current=result.current.rows[0];
      return reply.code(409).send({ code:'WORKSPACE_VERSION_CONFLICT', message:'Workspace was changed by another session', current:current ? { workspace:current.workspace, version:Number(current.version), updatedAt:current.updated_at } : null });
    }
    return { workspace:result.saved.workspace, version:Number(result.saved.version), updatedAt:result.saved.updated_at };
  });

  app.post('/api/v1/workspace/reset', async (request, reply) => {
    if(request.principal.id!=='local-admin')requireCapability(request.principal, 'codes:write');
    const body = z.object({ version:z.coerce.number().int().min(0).optional() }).strict().default({}).parse(request.body);
    const result = await db.transaction(async (client) => {
      const legacy=request.principal.id==='local-admin';
      const current = legacy ? await client.query('SELECT workspace,version,updated_at FROM admin_workspaces WHERE id=1 FOR UPDATE') : await client.query('SELECT workspace,version,updated_at FROM local_organization_workspaces WHERE organization_id=$1 FOR UPDATE',[request.principal.organizationId]);
      const currentRow = current.rows[0] || null;
      const currentVersion = currentRow ? Number(currentRow.version) : 0;
      if (body.version !== undefined && body.version !== currentVersion) {
        return { conflict:true, current:currentRow ? { workspace:currentRow.workspace, version:currentVersion, updatedAt:currentRow.updated_at } : null };
      }
      const state = emptyWorkspaceState();
      const saved = legacy
        ? (currentRow ? await client.query('UPDATE admin_workspaces SET workspace=$1,version=version+1,updated_at=now() WHERE id=1 RETURNING workspace,version,updated_at',[state]) : await client.query('INSERT INTO admin_workspaces(id,workspace,version) VALUES(1,$1,0) RETURNING workspace,version,updated_at',[state]))
        : (currentRow ? await client.query('UPDATE local_organization_workspaces SET workspace=$1,version=version+1,updated_at=now() WHERE organization_id=$2 RETURNING workspace,version,updated_at',[state,request.principal.organizationId]) : await client.query('INSERT INTO local_organization_workspaces(organization_id,workspace,version) VALUES($1,$2,0) RETURNING workspace,version,updated_at',[request.principal.organizationId,state]));
      if (legacy) await client.query('DELETE FROM admin_public_objects WHERE owner_user_id IS NULL');
      else await client.query(`DELETE FROM admin_public_objects WHERE owner_user_id=$1 OR owner_user_id IN (
        SELECT m.user_id FROM local_memberships m WHERE m.organization_id=(SELECT organization_id FROM local_memberships WHERE user_id=$1 AND status='ACTIVE' LIMIT 1)
      )`,[request.principal.id]);
      return { saved:saved.rows[0] };
    });
    if (result.conflict) return reply.code(409).send({ code:'WORKSPACE_VERSION_CONFLICT', message:'Workspace was changed by another session', current:result.current });
    return { workspace:result.saved.workspace, version:Number(result.saved.version), updatedAt:result.saved.updated_at };
  });
  app.get("/api/public/v1/objects/:publicId",{config:{rateLimit:{max:300,timeWindow:"1 minute"}}}, async (request, reply) => {
    const publicId = z.string().uuid().parse(request.params.publicId);
    const result = await db.query(
      `SELECT so.id,so.public_id,so.level,so.lot,so.status,so.created_at,so.tenant_id,p.gtin,p.name product_name,
       EXISTS(SELECT 1 FROM recall_objects ro JOIN recalls r ON r.id=ro.recall_id AND r.tenant_id=ro.tenant_id
              WHERE ro.object_id=so.id AND ro.tenant_id=so.tenant_id AND r.status='ACTIVE') recalled
       FROM serialized_objects so JOIN products p ON p.id=so.product_id AND p.tenant_id=so.tenant_id
       WHERE so.public_id=$1 AND p.status='ACTIVE'`,
      [publicId]
    );
    if (!result.rowCount && config.AUTH_MODE === 'local') {
      const projected = await db.query('SELECT public_id,level,lot,status,commissioned_at,gtin,product_name,events FROM admin_public_objects WHERE public_id=$1', [publicId]);
      if (!projected.rowCount) return reply.code(404).send({ code:"PUBLIC_OBJECT_NOT_FOUND", message:"Reliable code not found" });
      const item=projected.rows[0];
      return { verified:true, product:{ name:item.product_name, gtin:item.gtin }, object:{ publicId:item.public_id, level:item.level, lot:item.lot, status:item.status, commissionedAt:item.commissioned_at }, events:Array.isArray(item.events) ? item.events.slice(0,20) : [] };
    }
    if (!result.rowCount) return reply.code(404).send({ code:"PUBLIC_OBJECT_NOT_FOUND", message:"Reliable code not found" });
    const object = result.rows[0];
    const events = await db.query(
      `SELECT event_type,event_time,verification_status
       FROM trace_events WHERE object_id=$1 AND verification_status='VERIFIED'
       ORDER BY event_time DESC,record_time DESC LIMIT 20`,
      [object.id]
    );
    return {
      verified:true,
      product:{ name:object.product_name, gtin:object.gtin },
      object:{ publicId:object.public_id, level:object.level, lot:object.lot, status:object.status, commissionedAt:object.created_at, recalled:Boolean(object.recalled) },
      events:events.rows.map((event) => ({ type:event.event_type, time:event.event_time }))
    };
  });

  app.get("/api/v1/me", async (request) => ({
    id: request.principal.id,
    name: request.principal.name,
    tenantId: request.principal.tenantId,
    organizationId: request.principal.organizationId,
    organizationName: request.principal.organizationName || null,
    role: request.principal.role,
    capabilities: [...request.principal.capabilities]
  }));

  app.get("/api/v1/objects/:code", async (request, reply) => {
    requireCapability(request.principal, "objects:read");
    const code = z.string().trim().min(6).max(200).transform((value) => value.toUpperCase()).parse(request.params.code);
    const result = await db.query(
      `SELECT so.id,so.public_id,so.code,so.level,so.lot,so.status,so.parent_id,so.current_organization_id,p.sku,p.gtin,p.name product_name,
              o.name current_organization
       FROM serialized_objects so JOIN products p ON p.id=so.product_id
       LEFT JOIN organizations o ON o.id=so.current_organization_id
       WHERE so.tenant_id=$1 AND so.code=$2`,
      [request.principal.tenantId, code]
    );
    if (!result.rowCount) return reply.code(404).send({ code: "OBJECT_NOT_FOUND", message: "Reliable code not found" });
    const object = result.rows[0];
    const events = await db.query(
      `SELECT id,event_type,event_time,record_time,read_point,verification_status,organization_id,shipment_id
       FROM trace_events WHERE tenant_id=$1 AND object_id=$2 ORDER BY event_time DESC,record_time DESC LIMIT 100`,
      [request.principal.tenantId, object.id]
    );
    return { object, events: events.rows };
  });

  app.post("/api/v1/code-batches", async (request, reply) => {
    if(!config.ENABLE_LEGACY_SYNC_CODE_GENERATION)return reply.code(410).send({code:"ASYNC_CODE_JOBS_REQUIRED",message:"Use /api/v1/code-jobs for production code generation"});
    requireCapability(request.principal, "codes:write");
    const body = codeBatchSchema.parse(request.body);
    const key = parseIdempotencyKey(request);
    const operation = "CREATE_CODE_BATCH";
    const hash = requestHash(operation, {...body,deviceId:String(request.headers["x-reliacode-device-id"]||"")});
    const response = await db.transaction(async (client) => {
      await lockIdempotencyKey(client, request.principal.tenantId, key);
      const cached = await getIdempotentResponse(client, request.principal.tenantId, key, hash);
      if (cached) return cached;
      const device=body.eventType==="VERIFY"?{deviceId:null,locationId:null,readPoint:body.readPoint}:await authorizeOperationalDevice(client,config,request,body.eventType,{fallbackReadPoint:body.readPoint});
      const product = await client.query("SELECT id FROM products WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'", [request.principal.tenantId, body.productId]);
      if (!product.rowCount) {
        const error = new Error("Product not found or inactive"); error.statusCode = 404; error.code = "PRODUCT_NOT_FOUND"; throw error;
      }
      const batch = await client.query(
        `INSERT INTO code_batches(tenant_id,product_id,level,quantity,serial_rule,created_by)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [request.principal.tenantId, body.productId, body.level, body.quantity, body.serialRule, request.principal.id]
      );
      const prefix = body.level === "ITEM" ? "RC-ITM" : body.level === "CASE" ? "RC-CTN" : "RC-PLT";
      for (let offset = 0; offset < body.quantity; offset += 1000) {
        const count = Math.min(1000, body.quantity - offset);
        const objects = Array.from({ length: count }, (_, innerIndex) => {
          const index = offset + innerIndex;
          return [request.principal.tenantId, body.productId, batch.rows[0].id, serial(prefix, body.serialRule, batch.rows[0].id, index), body.level, request.principal.organizationId];
        });
        const params = [];
        const values = objects.map((row) => `(${row.map((value) => { params.push(value); return `$${params.length}`; }).join(",")})`).join(",");
        await client.query(
          `INSERT INTO serialized_objects(tenant_id,product_id,code_batch_id,code,level,current_organization_id) VALUES ${values}`,
          params
        );
      }
      const result = { batch: batch.rows[0], generated: body.quantity };
      await audit(client, request, operation, "CODE_BATCH", batch.rows[0].id, null, result);
      await saveIdempotentResponse(client, { tenantId:request.principal.tenantId,key,operation,hash,status:201,body:result });
      return { status: 201, body: result };
    });
    return reply.code(response.status).send(response.body);
  });

  app.post("/api/v1/trace-events", async (request, reply) => {
    const body = traceEventSchema.parse(request.body);
    const capability = eventCapability[body.eventType];
    if (capability) requireCapability(request.principal, capability);
    else if (body.eventType !== "VERIFY") requireCapability(request.principal, `events:write:${body.eventType.toLowerCase()}`);
    else requireCapability(request.principal, "objects:read");
    const key = parseIdempotencyKey(request);
    const operation = `TRACE_EVENT:${body.eventType}`;
    const hash = requestHash(operation, body);
    const response = await db.transaction(async (client) => {
      await lockIdempotencyKey(client, request.principal.tenantId, key);
      const cached = await getIdempotentResponse(client, request.principal.tenantId, key, hash);
      if (cached) return cached;
      const device=body.eventType==="VERIFY"?{deviceId:null,locationId:null,readPoint:body.readPoint}:await authorizeOperationalDevice(client,config,request,body.eventType,{fallbackReadPoint:body.readPoint});
      const found = await client.query(
        `SELECT so.*,p.sku,p.gtin,p.name product_name FROM serialized_objects so JOIN products p ON p.id=so.product_id
         WHERE so.tenant_id=$1 AND so.code=$2 FOR UPDATE OF so`,
        [request.principal.tenantId, body.objectCode]
      );
      if (!found.rowCount) { const error=new Error("Reliable code not found");error.statusCode=404;error.code="OBJECT_NOT_FOUND";throw error; }
      const object = found.rows[0];
      let businessDocument = null;
      if (body.documentId) {
        const expectedType={PACKING:"PACKING_ORDER",UNPACKING:"PACKING_ORDER",REPACKING:"PACKING_ORDER",SHIPPING:"SHIPMENT",RECEIVING_DISTRIBUTOR:"RECEIPT",RECEIVING_STORE:"RECEIPT",RETURNING:"RETURN",SELLING:"SALE",DESTROYING:"DESTRUCTION"}[body.eventType];
        const documentResult=await client.query("SELECT * FROM business_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,body.documentId]);
        if(!documentResult.rowCount){const error=new Error("Business document not found");error.statusCode=404;error.code="DOCUMENT_NOT_FOUND";throw error;}
        businessDocument=documentResult.rows[0];
        if(businessDocument.document_type!==expectedType||!["APPROVED","IN_PROGRESS"].includes(businessDocument.status)){const error=new Error("Business document is not approved for this event");error.statusCode=409;error.code="DOCUMENT_NOT_ACTIONABLE";throw error;}
        const receiving=body.eventType.startsWith("RECEIVING_");
        const authorizedOrganization=receiving?businessDocument.to_organization_id:businessDocument.from_organization_id;
        if(authorizedOrganization&&authorizedOrganization!==request.principal.organizationId){const error=new Error("Business document does not authorize this organization");error.statusCode=404;error.code="DOCUMENT_NOT_FOUND";throw error;}
        const documentObject=await client.query("SELECT expected,line_role,fulfilled_event_id,object_snapshot FROM business_document_objects WHERE tenant_id=$1 AND document_id=$2 AND object_id=$3",[request.principal.tenantId,body.documentId,object.id]);
        if(!documentObject.rowCount||!documentObject.rows[0].expected){const error=new Error("The serialized object is not expected on this business document");error.statusCode=409;error.code="OBJECT_NOT_ON_DOCUMENT";throw error;}
        if(documentObject.rows[0].line_role!=="ACTION"){const error=new Error("The serialized object is context-only on this business document");error.statusCode=409;error.code="OBJECT_NOT_ACTIONABLE";throw error;}
        if(documentObject.rows[0].fulfilled_event_id){const error=new Error("The serialized object was already fulfilled on this business document");error.statusCode=409;error.code="OBJECT_ALREADY_PROCESSED";throw error;}
      }
      let shipment = null;
      if (body.shipmentId) {
        const shipmentResult = await client.query(
          `SELECT s.*,EXISTS(SELECT 1 FROM shipment_objects x WHERE x.shipment_id=s.id AND x.object_id=$3 AND x.expected) expected_object
           FROM shipments s WHERE s.tenant_id=$1 AND s.id=$2 FOR UPDATE`,
          [request.principal.tenantId, body.shipmentId, object.id]
        );
        shipment = shipmentResult.rows[0] || null;
      }
      const verificationShipment=shipment||((body.eventType.startsWith("RECEIVING_")&&businessDocument)?{to_organization_id:businessDocument.to_organization_id,expected_object:true}:null);
      const verification = verificationForEvent({ eventType:body.eventType, shipment:verificationShipment, object, principal:request.principal });
      if (verification.status === "REJECTED") {
        const error = new Error(`Event rejected: ${verification.risk.type}`); error.statusCode=409; error.code=verification.risk.type; throw error;
      }
      const nextStatus = nextObjectStatus(body.eventType, object.level, object.status);
      const stateApplied = body.eventType !== "VERIFY" && verification.status === "VERIFIED";
      const effectiveStatus = stateApplied ? nextStatus : object.status;
      const affectedObjects=[{...object,depth:0,resulting_status:effectiveStatus}];
      if(stateApplied&&!["PACKING","UNPACKING","REPACKING"].includes(body.eventType)&&["CASE","PALLET"].includes(object.level)){
        const descendants=await client.query(`WITH RECURSIVE tree AS (
          SELECT id,parent_id,0 depth,ARRAY[id] path FROM serialized_objects WHERE tenant_id=$1 AND id=$2
          UNION ALL
          SELECT child.id,child.parent_id,tree.depth+1,tree.path||child.id FROM tree
          JOIN serialized_objects child ON child.tenant_id=$1 AND child.parent_id=tree.id
          WHERE tree.depth<16 AND NOT child.id=ANY(tree.path)
        ) SELECT so.*,tree.depth FROM tree JOIN serialized_objects so ON so.tenant_id=$1 AND so.id=tree.id
          WHERE tree.depth>0 ORDER BY tree.depth,so.id FOR UPDATE OF so`,[request.principal.tenantId,object.id]);
        for(const descendant of descendants.rows)affectedObjects.push({...descendant,resulting_status:nextObjectStatus(body.eventType,descendant.level,descendant.status)});
      }
      let parentObject=null,previousParentObject=null;
      if(body.eventType==="PACKING"){
        const parent=await client.query("SELECT * FROM serialized_objects WHERE tenant_id=$1 AND code=$2 FOR UPDATE",[request.principal.tenantId,body.parentObjectCode]);
        if(!parent.rowCount){const error=new Error("Parent object not found");error.statusCode=404;error.code="OBJECT_NOT_FOUND";throw error;}
        parentObject=parent.rows[0];const ranks={ITEM:1,CASE:2,PALLET:3};
        if(ranks[parentObject.level]<=ranks[object.level]||parentObject.status==="DESTROYED"){const error=new Error("Invalid packaging parent");error.statusCode=409;error.code="INVALID_PACKAGING_PARENT";throw error;}
        if(parentObject.current_organization_id&&parentObject.current_organization_id!==request.principal.organizationId){const error=new Error("Packaging parent is held by another organization");error.statusCode=404;error.code="OBJECT_NOT_FOUND";throw error;}
        if(object.parent_id){const error=new Error("Object is already packed");error.statusCode=409;error.code="OBJECT_ALREADY_PACKED";throw error;}
      }
      if(body.eventType==="UNPACKING"){
        if(!object.parent_id){const error=new Error("Object is not currently packed");error.statusCode=409;error.code="OBJECT_NOT_PACKED";throw error;}
        const parent=await client.query("SELECT * FROM serialized_objects WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,object.parent_id]);
        if(!parent.rowCount){const error=new Error("Packaging parent not found");error.statusCode=409;error.code="PACKAGING_RELATIONSHIP_INVALID";throw error;}parentObject=parent.rows[0];
      }
      if(body.eventType==="REPACKING"){
        if(!object.parent_id){const error=new Error("Object is not currently packed");error.statusCode=409;error.code="OBJECT_NOT_PACKED";throw error;}
        const parents=await client.query("SELECT * FROM serialized_objects WHERE tenant_id=$1 AND (id=$2 OR code=$3) ORDER BY id FOR UPDATE",[request.principal.tenantId,object.parent_id,body.parentObjectCode]);
        previousParentObject=parents.rows.find(row=>row.id===object.parent_id)||null;parentObject=parents.rows.find(row=>row.code===body.parentObjectCode)||null;
        if(!previousParentObject){const error=new Error("Current packaging parent not found");error.statusCode=409;error.code="PACKAGING_RELATIONSHIP_INVALID";throw error;}
        if(!parentObject){const error=new Error("New packaging parent not found");error.statusCode=404;error.code="OBJECT_NOT_FOUND";throw error;}
        const ranks={ITEM:1,CASE:2,PALLET:3};
        if(parentObject.id===previousParentObject.id){const error=new Error("New packaging parent must differ from the current parent");error.statusCode=409;error.code="SAME_PACKAGING_PARENT";throw error;}
        if(ranks[parentObject.level]<=ranks[object.level]||parentObject.status==="DESTROYED"){const error=new Error("Invalid new packaging parent");error.statusCode=409;error.code="INVALID_PACKAGING_PARENT";throw error;}
        if(parentObject.current_organization_id&&parentObject.current_organization_id!==request.principal.organizationId){const error=new Error("Packaging parent is held by another organization");error.statusCode=404;error.code="OBJECT_NOT_FOUND";throw error;}
      }
      if(parentObject&&businessDocument){
        for(const requiredParent of [previousParentObject,parentObject].filter((value,index,array)=>value&&array.findIndex(item=>item?.id===value.id)===index)){
          const parentLine=await client.query("SELECT expected FROM business_document_objects WHERE tenant_id=$1 AND document_id=$2 AND object_id=$3",[request.principal.tenantId,businessDocument.id,requiredParent.id]);
          if(!parentLine.rowCount||!parentLine.rows[0].expected){const error=new Error("Every packaging parent must be expected on this business document");error.statusCode=409;error.code="PARENT_NOT_ON_DOCUMENT";throw error;}
        }
      }
      const event = await client.query(
        `INSERT INTO trace_events(tenant_id,event_type,object_id,shipment_id,business_document_id,actor_id,actor_role,organization_id,device_id,location_id,event_time,read_point,verification_status,metadata,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [request.principal.tenantId,body.eventType,object.id,body.shipmentId||null,body.documentId||null,request.principal.id,request.principal.role,request.principal.organizationId,device.deviceId,device.locationId,body.eventTime,device.readPoint,verification.status,body.metadata,key]
      );
      const snapshots=affectedObjects.map(item=>({objectId:item.id,depth:item.depth,parentObjectId:item.parent_id||null,resultingParentObjectId:body.eventType==="PACKING"||body.eventType==="REPACKING"?parentObject.id:body.eventType==="UNPACKING"?null:item.parent_id||null,previousStatus:item.status,resultingStatus:item.resulting_status,objectSnapshot:{code:item.code,level:item.level,lot:item.lot||null,parentObjectId:item.parent_id||null,currentOrganizationId:item.current_organization_id||null,productId:item.product_id}}));
      await client.query(`INSERT INTO trace_event_object_snapshots(tenant_id,trace_event_id,object_id,depth,parent_object_id,resulting_parent_object_id,previous_status,resulting_status,object_snapshot)
        SELECT $1,$2,x.object_id,x.depth,x.parent_object_id,x.resulting_parent_object_id,x.previous_status,x.resulting_status,x.object_snapshot
        FROM jsonb_to_recordset($3::jsonb) AS x(object_id uuid,depth integer,parent_object_id uuid,resulting_parent_object_id uuid,previous_status text,resulting_status text,object_snapshot jsonb)`,[request.principal.tenantId,event.rows[0].id,JSON.stringify(snapshots.map(item=>({object_id:item.objectId,depth:item.depth,parent_object_id:item.parentObjectId,resulting_parent_object_id:item.resultingParentObjectId,previous_status:item.previousStatus,resulting_status:item.resultingStatus,object_snapshot:item.objectSnapshot})))]);
      await client.query(
        `INSERT INTO event_outbox(tenant_id,aggregate_type,aggregate_id,event_type,payload)
         VALUES($1,'SERIALIZED_OBJECT',$2,'TRACE_EVENT_CAPTURED',$3)`,
        [request.principal.tenantId,object.id,{ event:event.rows[0], object:{ id:object.id, code:object.code, level:object.level, productId:object.product_id },...(parentObject?{aggregations:body.eventType==="REPACKING"?[{parent:{id:previousParentObject.id,code:previousParentObject.code,level:previousParentObject.level},child:{id:object.id,code:object.code,level:object.level},action:"DELETE"},{parent:{id:parentObject.id,code:parentObject.code,level:parentObject.level},child:{id:object.id,code:object.code,level:object.level},action:"ADD"}]:[{parent:{id:parentObject.id,code:parentObject.code,level:parentObject.level},child:{id:object.id,code:object.code,level:object.level},action:body.eventType==="PACKING"?"ADD":"DELETE"}]}:{}) }]
      );
      if (stateApplied) {
        const parentId=["PACKING","REPACKING"].includes(body.eventType)?parentObject.id:body.eventType==="UNPACKING"?null:object.parent_id;
        await client.query("UPDATE serialized_objects SET status=$1,current_organization_id=$2,parent_id=$3 WHERE tenant_id=$4 AND id=$5", [nextStatus, request.principal.organizationId,parentId,request.principal.tenantId,object.id]);
        if(affectedObjects.length>1)await client.query(`UPDATE serialized_objects so SET status=x.resulting_status,current_organization_id=$2
          FROM jsonb_to_recordset($1::jsonb) AS x(object_id uuid,resulting_status text)
          WHERE so.tenant_id=$3 AND so.id=x.object_id`,[JSON.stringify(affectedObjects.slice(1).map(item=>({object_id:item.id,resulting_status:item.resulting_status}))),request.principal.organizationId,request.principal.tenantId]);
        if(["PACKING","UNPACKING","REPACKING"].includes(body.eventType)){
          const changes=body.eventType==="REPACKING"?[[previousParentObject.id,"DELETE"],[parentObject.id,"ADD"]]:[[parentObject.id,body.eventType==="PACKING"?"ADD":"DELETE"]];
          for(const [relationshipParent,action] of changes)await client.query(`INSERT INTO package_relationship_events(tenant_id,parent_object_id,child_object_id,action,business_document_id,trace_event_id,actor_id,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[request.principal.tenantId,relationshipParent,object.id,action,body.documentId,event.rows[0].id,request.principal.id,body.eventTime]);
        }
        if(businessDocument){
          const fulfilled=await client.query("UPDATE business_document_objects SET fulfilled_event_id=$1,fulfilled_at=$2 WHERE tenant_id=$3 AND document_id=$4 AND object_id=$5 AND expected AND line_role='ACTION' AND fulfilled_event_id IS NULL RETURNING object_id",[event.rows[0].id,body.eventTime,request.principal.tenantId,businessDocument.id,object.id]);
          if(!fulfilled.rowCount){const error=new Error("The document object could not be fulfilled");error.statusCode=409;error.code="DOCUMENT_OBJECT_CONFLICT";throw error;}
          await client.query("UPDATE business_documents SET status='IN_PROGRESS',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='APPROVED'",[request.principal.tenantId,businessDocument.id]);
        }
      }
      if(body.eventType!=="VERIFY")await enqueueWebhookDeliveries(client,request.principal.tenantId,body.eventType,{eventId:event.rows[0].id,eventType:body.eventType,eventTime:body.eventTime,object:{code:object.code,level:object.level,status:effectiveStatus},verificationStatus:verification.status});
      let riskCase = null;
      if (verification.risk) {
        const risk = await client.query(
          `INSERT INTO risk_cases(tenant_id,trace_event_id,risk_type,severity,evidence)
           VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [request.principal.tenantId,event.rows[0].id,verification.risk.type,verification.risk.severity,{objectCode:body.objectCode,shipmentId:body.shipmentId,deviceId:device.deviceId}]
        );
        riskCase = risk.rows[0];
      }
      let reward = { claim:null, ledgerEntry:null, reason:"EVENT_NOT_REWARDABLE" };
      if (verification.status === "VERIFIED" && ["RECEIVING_DISTRIBUTOR","RECEIVING_STORE"].includes(body.eventType)) {
        reward = await createRewardForEvent(client, { request, event:event.rows[0], object, idempotencyKey:key });
        if (reward.reason === "AMBIGUOUS_CAMPAIGN") {
          const conflict = await client.query(
            `INSERT INTO risk_cases(tenant_id,trace_event_id,risk_type,severity,evidence) VALUES($1,$2,'AMBIGUOUS_CAMPAIGN','HIGH',$3) RETURNING *`,
            [request.principal.tenantId,event.rows[0].id,{objectCode:body.objectCode}]
          );
          riskCase = conflict.rows[0];
        }
      }
      const result = { event:event.rows[0], object:{...object,status:effectiveStatus}, stateApplied, affectedObjectCount:affectedObjects.length, riskCase, reward };
      await audit(client, request, operation, "TRACE_EVENT", event.rows[0].id, null, result);
      await saveIdempotentResponse(client,{tenantId:request.principal.tenantId,key,operation,hash,status:201,body:result});
      return { status:201, body:result };
    });
    return reply.code(response.status).send(response.body);
  });

  app.post("/api/v1/risk-cases/:id/decisions", async (request, reply) => {
    requireCapability(request.principal, "risks:review");
    const riskId = z.string().uuid().parse(request.params.id);
    const body = riskDecisionSchema.parse(request.body);
    const key = parseIdempotencyKey(request);
    const operation = "RISK_DECISION";
    const hash = requestHash(operation, { id:riskId, ...body });
    const response = await db.transaction(async (client) => {
      await lockIdempotencyKey(client, request.principal.tenantId, key);
      const cached = await getIdempotentResponse(client, request.principal.tenantId, key, hash);
      if (cached) return cached;
      const found = await client.query("SELECT * FROM risk_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [request.principal.tenantId, riskId]);
      if (!found.rowCount) { const error=new Error("Risk case not found");error.statusCode=404;error.code="RISK_NOT_FOUND";throw error; }
      if (!["OPEN","HELD"].includes(found.rows[0].status)) { const error=new Error("Risk case is already final");error.statusCode=409;error.code="RISK_ALREADY_FINAL";throw error; }
      const nextStatus = body.action === "APPROVE" ? "APPROVED" : body.action === "REJECT" ? "REJECTED" : "HELD";
      const changed = await client.query(
        `UPDATE risk_cases SET status=$1,resolved_at=CASE WHEN $1='HELD' THEN NULL ELSE now() END,
         resolved_by=CASE WHEN $1='HELD' THEN NULL ELSE $2 END,resolution_reason=$3 WHERE id=$4 RETURNING *`,
        [nextStatus, request.principal.id, body.reason, found.rows[0].id]
      );
      await audit(client, request, operation, "RISK_CASE", found.rows[0].id, found.rows[0], changed.rows[0]);
      await saveIdempotentResponse(client,{tenantId:request.principal.tenantId,key,operation,hash,status:200,body:changed.rows[0]});
      return { status:200, body:changed.rows[0] };
    });
    return reply.code(response.status).send(response.body);
  });
}
