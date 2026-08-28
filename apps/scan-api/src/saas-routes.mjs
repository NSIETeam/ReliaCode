import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requireCapability, hashToken } from "./auth.mjs";
import { getIdempotentResponse, lockIdempotencyKey, requestHash, saveIdempotentResponse } from "./idempotency.mjs";
import { parseIdempotencyKey } from "./schemas.mjs";

const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const reason = z.string().trim().min(3).max(500);
const uuid = z.string().uuid();
const pageQuery = z.object({ cursor:z.string().optional(), limit:z.coerce.number().int().min(1).max(200).default(50) });

function cursorEncode(row) { return Buffer.from(JSON.stringify([row.created_at, row.id])).toString("base64url"); }
function cursorDecode(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error();
    return parsed;
  } catch { const error=new Error("Invalid pagination cursor"); error.statusCode=400; error.code="CURSOR_INVALID"; throw error; }
}
function page(rows, limit) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor:hasMore ? cursorEncode(items.at(-1)) : null };
}
function notFound(message="Resource not found") { const error=new Error(message); error.statusCode=404; error.code="NOT_FOUND"; throw error; }
async function tx(db, work) { return typeof db.transaction === "function" ? db.transaction(work) : work(db); }
async function tenantAudit(client, request, action, entityType, entityId, beforeState, afterState) {
  return client.query(
    `INSERT INTO audit_log(tenant_id,actor_id,actor_role,organization_id,action,entity_type,entity_id,request_id,before_state,after_state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [request.principal.tenantId,request.principal.id,request.principal.role,request.principal.organizationId,action,entityType,String(entityId),request.id,beforeState,afterState]
  );
}
async function command(db, request, operation, input, work) {
  const key = parseIdempotencyKey(request);
  const hash = requestHash(operation, input);
  return tx(db, async (client) => {
    await lockIdempotencyKey(client, request.principal.tenantId, key);
    const cached = await getIdempotentResponse(client, request.principal.tenantId, key, hash);
    if (cached) return cached;
    const body = await work(client, key);
    await saveIdempotentResponse(client,{ tenantId:request.principal.tenantId,key,operation,hash,status:body.status || 200,body:body.value });
    return { status:body.status || 200, body:body.value };
  });
}

export function registerSaasRoutes(app, { db }) {
  app.post("/api/v1/tenant-applications", { config:{ rateLimit:{ max:10, timeWindow:"1 hour" } } }, async (request, reply) => {
    const body = z.object({
      companyName:z.string().trim().min(2).max(160), contactName:z.string().trim().min(2).max(100),
      contactEmail:email, contactPhone:z.string().trim().max(40).optional(), expectedMonthlyCodes:z.number().int().min(0).max(100000000).default(0)
    }).parse(request.body);
    let created;
    try { created = await db.query(
        `INSERT INTO tenant_applications(company_name,contact_name,contact_email,contact_phone,expected_monthly_codes)
         VALUES($1,$2,$3,$4,$5) RETURNING id,status,created_at`,
        [body.companyName,body.contactName,body.contactEmail,body.contactPhone || null,body.expectedMonthlyCodes]
      );
    } catch(error) { if(error.code==="23505"){error.statusCode=409;error.code="APPLICATION_PENDING";error.message="A pending application already exists for this email";} throw error; }
    return reply.code(202).send(created.rows[0]);
  });

  app.get("/api/v1/platform/tenant-applications", async (request) => {
    requireCapability(request.principal,"platform:tenants:read");
    const query = pageQuery.extend({ status:z.enum(["PENDING","APPROVED","REJECTED","WITHDRAWN"]).optional() }).parse(request.query);
    const cursor = cursorDecode(query.cursor);
    const result = await db.query(
      `SELECT * FROM tenant_applications WHERE ($1::text IS NULL OR status=$1)
       AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,
      [query.status || null,cursor?.[0] || null,cursor?.[1] || null,query.limit+1]
    );
    return page(result.rows,query.limit);
  });

  app.post("/api/v1/platform/tenant-applications/:id/decision", async (request, reply) => {
    requireCapability(request.principal,"platform:tenants:write");
    const applicationId=uuid.parse(request.params.id);
    const body=z.object({ action:z.enum(["APPROVE","REJECT"]), reason, plan:z.enum(["free","team","enterprise"]).default("free") }).parse(request.body);
    const key=parseIdempotencyKey(request);
    const result=await tx(db,async(client)=>{
      const found=await client.query("SELECT * FROM tenant_applications WHERE id=$1 FOR UPDATE",[applicationId]);
      if(!found.rowCount) notFound("Tenant application not found");
      if(found.rows[0].status!=="PENDING"){ const e=new Error("Application was already reviewed");e.statusCode=409;e.code="APPLICATION_FINAL";throw e; }
      let tenantId=null;
      if(body.action==="APPROVE"){
        const tenant=await client.query("INSERT INTO tenants(name,status,plan,approved_at) VALUES($1,'ACTIVE',$2,now()) RETURNING id",[found.rows[0].company_name,body.plan]);
        tenantId=tenant.rows[0].id;
        await client.query("INSERT INTO organizations(tenant_id,type,name) VALUES($1,'BRAND',$2)",[tenantId,found.rows[0].company_name]);
        await client.query("INSERT INTO tenant_settings(tenant_id) VALUES($1)",[tenantId]);
      }
      const changed=await client.query(
        "UPDATE tenant_applications SET status=$1,review_reason=$2,reviewed_by=$3,reviewed_at=now(),tenant_id=$4 WHERE id=$5 RETURNING *",
        [body.action==="APPROVE"?"APPROVED":"REJECTED",body.reason,request.principal.id,tenantId,applicationId]
      );
      await client.query(
        `INSERT INTO platform_audit_log(actor_id,action,entity_type,entity_id,reason,request_id,before_state,after_state)
         VALUES($1,'TENANT_APPLICATION_DECISION','TENANT_APPLICATION',$2,$3,$4,$5,$6)`,
        [request.principal.id,applicationId,body.reason,request.id,found.rows[0],changed.rows[0]]
      );
      return changed.rows[0];
    });
    reply.header("idempotency-key",key);
    return reply.send(result);
  });

  app.get("/api/v1/products", async (request) => {
    requireCapability(request.principal,"objects:read");
    const query=pageQuery.extend({ status:z.enum(["ACTIVE","INACTIVE"]).optional(), q:z.string().trim().max(100).optional() }).parse(request.query);
    const cursor=cursorDecode(query.cursor);
    const result=await db.query(
      `SELECT id,sku,gtin,name,status,created_at FROM products WHERE tenant_id=$1
       AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR sku ILIKE '%'||$3||'%' OR name ILIKE '%'||$3||'%')
       AND ($4::timestamptz IS NULL OR (created_at,id)<($4,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6`,
      [request.principal.tenantId,query.status||null,query.q||null,cursor?.[0]||null,cursor?.[1]||null,query.limit+1]
    );
    return page(result.rows,query.limit);
  });

  app.post("/api/v1/products", async (request,reply) => {
    requireCapability(request.principal,"products:write");
    const body=z.object({ sku:z.string().trim().min(1).max(80), gtin:z.string().regex(/^\d{8,14}$/).optional(), name:z.string().trim().min(1).max(160), auditReason:reason }).parse(request.body);
    const response=await command(db,request,"PRODUCT_CREATE",body,async(client)=>{
      const created=await client.query("INSERT INTO products(tenant_id,sku,gtin,name) VALUES($1,$2,$3,$4) RETURNING *",[request.principal.tenantId,body.sku,body.gtin||null,body.name]);
      await tenantAudit(client,request,"PRODUCT_CREATE","PRODUCT",created.rows[0].id,null,created.rows[0]);
      return {status:201,value:created.rows[0]};
    });
    return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/locations", async (request) => {
    requireCapability(request.principal,"objects:read");
    const result=await db.query("SELECT * FROM locations WHERE tenant_id=$1 ORDER BY created_at DESC",[request.principal.tenantId]);
    return {items:result.rows};
  });
  app.post("/api/v1/locations", async(request,reply)=>{
    requireCapability(request.principal,"locations:write");
    const body=z.object({ organizationId:uuid,code:z.string().trim().min(1).max(80),gln:z.string().regex(/^\d{13}$/).optional(),name:z.string().trim().min(1).max(160),type:z.enum(["FACTORY","WAREHOUSE","DISTRIBUTOR","STORE","OFFICE"]),city:z.string().max(80).optional(),region:z.string().max(80).optional(),auditReason:reason }).parse(request.body);
    const response=await command(db,request,"LOCATION_CREATE",body,async(client)=>{
      const org=await client.query("SELECT 1 FROM organizations WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,body.organizationId]); if(!org.rowCount) notFound();
      const created=await client.query("INSERT INTO locations(tenant_id,organization_id,code,gln,name,type,city,region) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[request.principal.tenantId,body.organizationId,body.code,body.gln||null,body.name,body.type,body.city||null,body.region||null]);
      await tenantAudit(client,request,"LOCATION_CREATE","LOCATION",created.rows[0].id,null,created.rows[0]); return {status:201,value:created.rows[0]};
    }); return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/devices",async(request)=>{requireCapability(request.principal,"objects:read");const result=await db.query("SELECT * FROM devices WHERE tenant_id=$1 ORDER BY created_at DESC",[request.principal.tenantId]);return{items:result.rows};});
  app.post("/api/v1/devices",async(request,reply)=>{
    requireCapability(request.principal,"devices:write");const body=z.object({organizationId:uuid,locationId:uuid,name:z.string().trim().min(1).max(120),publicKey:z.string().max(8000).optional(),allowedEventTypes:z.array(z.string().trim().min(1).max(80)).max(30),auditReason:reason}).parse(request.body);
    const response=await command(db,request,"DEVICE_REGISTER",body,async(client)=>{const location=await client.query("SELECT 1 FROM locations WHERE tenant_id=$1 AND id=$2 AND organization_id=$3",[request.principal.tenantId,body.locationId,body.organizationId]);if(!location.rowCount)notFound("Location not found");const created=await client.query("INSERT INTO devices(tenant_id,organization_id,location_id,name,public_key,allowed_event_types) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[request.principal.tenantId,body.organizationId,body.locationId,body.name,body.publicKey||null,body.allowedEventTypes]);await tenantAudit(client,request,"DEVICE_REGISTER","DEVICE",created.rows[0].id,null,created.rows[0]);return{status:201,value:created.rows[0]};});return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/devices/:id/revoke",async(request,reply)=>{
    requireCapability(request.principal,"devices:write");const id=uuid.parse(request.params.id),body=z.object({auditReason:reason}).parse(request.body);const response=await command(db,request,"DEVICE_REVOKE",{id,...body},async(client)=>{const found=await client.query("SELECT * FROM devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]);if(!found.rowCount)notFound();const changed=await client.query("UPDATE devices SET status='REVOKED',revoked_at=now(),revoked_by=$1 WHERE id=$2 RETURNING *",[request.principal.id,id]);await tenantAudit(client,request,"DEVICE_REVOKE","DEVICE",id,found.rows[0],changed.rows[0]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/documents",async(request)=>{requireCapability(request.principal,"events:read");const result=await db.query("SELECT * FROM business_documents WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200",[request.principal.tenantId]);return{items:result.rows};});
  app.post("/api/v1/documents",async(request,reply)=>{
    requireCapability(request.principal,"documents:write");const body=z.object({documentType:z.enum(["PRODUCTION_ORDER","PACKING_ORDER","SHIPMENT","RECEIPT","RETURN","DESTRUCTION"]),reference:z.string().trim().min(1).max(120),fromOrganizationId:uuid.optional(),toOrganizationId:uuid.optional(),metadata:z.record(z.string(),z.unknown()).default({}),auditReason:reason}).parse(request.body);
    const response=await command(db,request,"DOCUMENT_CREATE",body,async(client)=>{for(const orgId of [body.fromOrganizationId,body.toOrganizationId].filter(Boolean)){const org=await client.query("SELECT 1 FROM organizations WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,orgId]);if(!org.rowCount)notFound("Organization not found");}const created=await client.query(`INSERT INTO business_documents(tenant_id,document_type,reference,from_organization_id,to_organization_id,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[request.principal.tenantId,body.documentType,body.reference,body.fromOrganizationId||null,body.toOrganizationId||null,body.metadata,request.principal.id]);await tenantAudit(client,request,"DOCUMENT_CREATE","BUSINESS_DOCUMENT",created.rows[0].id,null,created.rows[0]);return{status:201,value:created.rows[0]};});return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/documents/:id/transition",async(request,reply)=>{
    requireCapability(request.principal,"documents:write");const id=uuid.parse(request.params.id),body=z.object({expectedVersion:z.number().int().min(0),status:z.enum(["APPROVED","IN_PROGRESS","COMPLETED","CANCELLED"]),auditReason:reason}).parse(request.body);const response=await command(db,request,"DOCUMENT_TRANSITION",{id,...body},async(client)=>{const found=await client.query("SELECT * FROM business_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]);if(!found.rowCount)notFound();if(Number(found.rows[0].version)!==body.expectedVersion){const e=new Error("Document version changed");e.statusCode=409;e.code="VERSION_CONFLICT";throw e;}const allowed={DRAFT:["APPROVED","CANCELLED"],APPROVED:["IN_PROGRESS","CANCELLED"],IN_PROGRESS:["COMPLETED","CANCELLED"]};if(!allowed[found.rows[0].status]?.includes(body.status)){const e=new Error("Invalid document state transition");e.statusCode=409;e.code="INVALID_STATE";throw e;}const changed=await client.query("UPDATE business_documents SET status=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",[body.status,id]);await tenantAudit(client,request,"DOCUMENT_TRANSITION","BUSINESS_DOCUMENT",id,found.rows[0],changed.rows[0]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/code-jobs",async(request)=>{
    requireCapability(request.principal,"codes:write"); const result=await db.query("SELECT * FROM code_generation_jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200",[request.principal.tenantId]); return {items:result.rows};
  });
  app.post("/api/v1/code-jobs",async(request,reply)=>{
    requireCapability(request.principal,"codes:write");
    const body=z.object({productId:uuid,level:z.enum(["ITEM","CASE","PALLET"]),quantity:z.number().int().min(1).max(1000000),serialRule:z.enum(["RANDOM","SEQUENTIAL"]),lot:z.string().trim().max(120).optional(),auditReason:reason}).parse(request.body);
    const response=await command(db,request,"CODE_JOB_CREATE",body,async(client,key)=>{
      const product=await client.query("SELECT 1 FROM products WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",[request.principal.tenantId,body.productId]); if(!product.rowCount) notFound("Product not found");
      const created=await client.query(`INSERT INTO code_generation_jobs(tenant_id,product_id,requested_by,level,quantity,serial_rule,lot,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[request.principal.tenantId,body.productId,request.principal.id,body.level,body.quantity,body.serialRule,body.lot||null,key]);
      await tenantAudit(client,request,"CODE_JOB_CREATE","CODE_GENERATION_JOB",created.rows[0].id,null,created.rows[0]); return {status:202,value:created.rows[0]};
    }); return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/code-jobs/:id/approve",async(request,reply)=>{
    requireCapability(request.principal,"codes:approve"); const id=uuid.parse(request.params.id); const body=z.object({auditReason:reason}).parse(request.body);
    const response=await command(db,request,"CODE_JOB_APPROVE",{id,...body},async(client)=>{
      const found=await client.query("SELECT * FROM code_generation_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]); if(!found.rowCount) notFound();
      if(found.rows[0].status!=="PENDING_APPROVAL"){const e=new Error("Job cannot be approved in its current state");e.statusCode=409;e.code="INVALID_STATE";throw e;}
      const changed=await client.query("UPDATE code_generation_jobs SET status='QUEUED',approved_by=$1 WHERE id=$2 RETURNING *",[request.principal.id,id]);
      await tenantAudit(client,request,"CODE_JOB_APPROVE","CODE_GENERATION_JOB",id,found.rows[0],changed.rows[0]); return {value:changed.rows[0]};
    }); return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/recalls",async(request)=>{requireCapability(request.principal,"events:read");const result=await db.query("SELECT * FROM recalls WHERE tenant_id=$1 ORDER BY created_at DESC",[request.principal.tenantId]);return {items:result.rows};});
  app.post("/api/v1/recalls",async(request,reply)=>{
    requireCapability(request.principal,"recalls:write"); const body=z.object({reference:z.string().trim().min(1).max(100),title:z.string().trim().min(1).max(200),reason:reason,scope:z.object({productIds:z.array(uuid).max(100).default([]),lots:z.array(z.string().max(120)).max(100).default([])}),auditReason:reason}).parse(request.body);
    const response=await command(db,request,"RECALL_CREATE",body,async(client)=>{const created=await client.query("INSERT INTO recalls(tenant_id,reference,title,reason,scope,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[request.principal.tenantId,body.reference,body.title,body.reason,body.scope,request.principal.id]);await tenantAudit(client,request,"RECALL_CREATE","RECALL",created.rows[0].id,null,created.rows[0]);return {status:201,value:created.rows[0]};});return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/recalls/:id/activate",async(request,reply)=>{
    requireCapability(request.principal,"recalls:write"); const id=uuid.parse(request.params.id); const body=z.object({auditReason:reason}).parse(request.body);
    const response=await command(db,request,"RECALL_ACTIVATE",{id,...body},async(client)=>{const found=await client.query("SELECT * FROM recalls WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]);if(!found.rowCount)notFound();if(found.rows[0].status!=="DRAFT"){const e=new Error("Recall is not a draft");e.statusCode=409;e.code="INVALID_STATE";throw e;}const changed=await client.query("UPDATE recalls SET status='ACTIVE',activated_by=$1,activated_at=now() WHERE id=$2 RETURNING *",[request.principal.id,id]);await tenantAudit(client,request,"RECALL_ACTIVATE","RECALL",id,found.rows[0],changed.rows[0]);return {value:changed.rows[0]};});return reply.code(response.status).send(response.body);
  });

  app.post("/api/v1/supply-relationships",async(request,reply)=>{
    requireCapability(request.principal,"relationships:write"); const body=z.object({targetTenantId:uuid.optional(),targetEmail:email.optional(),relationshipType:z.enum(["MANUFACTURER","DISTRIBUTOR","RETAILER","LOGISTICS","SERVICE_PROVIDER"]),scopes:z.array(z.enum(["TRACE_READ","SHIPMENT_WRITE","RECEIPT_WRITE","RECALL_READ"])).min(1).max(10),auditReason:reason}).refine(v=>v.targetTenantId||v.targetEmail,{message:"A target tenant or email is required"}).parse(request.body);
    const response=await command(db,request,"RELATIONSHIP_INVITE",body,async(client)=>{const token=randomBytes(32).toString("base64url");const created=await client.query(`INSERT INTO supply_relationships(source_tenant_id,target_tenant_id,target_email,relationship_type,scopes,invitation_token_hash,invited_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,source_tenant_id,target_tenant_id,target_email,relationship_type,scopes,status,created_at`,[request.principal.tenantId,body.targetTenantId||null,body.targetEmail||null,body.relationshipType,body.scopes,hashToken(token),request.principal.id]);await tenantAudit(client,request,"RELATIONSHIP_INVITE","SUPPLY_RELATIONSHIP",created.rows[0].id,null,created.rows[0]);return {status:201,value:{relationship:created.rows[0],invitationToken:token}};});return reply.code(response.status).send(response.body);
  });
}
