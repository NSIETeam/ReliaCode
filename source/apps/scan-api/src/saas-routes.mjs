import { randomBytes, randomUUID as randomUuid } from "node:crypto";
import { z } from "zod";
import { requireCapability, requireAnyCapability, hashPassword, hashToken } from "./auth.mjs";
import { getIdempotentResponse, lockIdempotencyKey, requestHash, saveIdempotentResponse } from "./idempotency.mjs";
import { parseIdempotencyKey } from "./schemas.mjs";
import { createObjectStorage,presignCodeExport } from "./object-storage.mjs";
import { isValidGln,isValidGs1X,isValidGtin,ssccCapacity } from "./gs1.mjs";
import { enqueueWebhookDeliveries } from "./webhooks.mjs";

const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const reason = z.string().trim().min(3).max(500);
const uuid = z.string().uuid();
const deviceEventType=z.enum(["PACKING","UNPACKING","REPACKING","SHIPPING","RECEIVING_DISTRIBUTOR","RECEIVING_STORE","RETURNING","SELLING","DESTROYING"]);
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
function rethrowUnique(error,code,message){if(error?.code==="23505"){error.statusCode=409;error.code=code;error.message=message;}throw error;}
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
async function platformCommand(db,request,operation,input,work){const key=parseIdempotencyKey(request),hash=requestHash(operation,input);return tx(db,async(client)=>{await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["platform:"+key]);const existing=await client.query("SELECT request_hash,response_status,response_body FROM platform_idempotency_records WHERE idempotency_key=$1 AND expires_at>now()",[key]);if(existing.rowCount){if(existing.rows[0].request_hash!==hash){const e=new Error("Idempotency key was already used with a different request");e.statusCode=409;e.code="IDEMPOTENCY_CONFLICT";throw e;}return{status:existing.rows[0].response_status,body:existing.rows[0].response_body};}const result=await work(client);await client.query(`INSERT INTO platform_idempotency_records(idempotency_key,operation,request_hash,response_status,response_body,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '24 hours')`,[key,operation,hash,result.status||200,result.value]);return{status:result.status||200,body:result.value};});}

export function registerSaasRoutes(app, { db,config }) {
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
    const response=await platformCommand(db,request,"TENANT_APPLICATION_DECISION",{applicationId,...body},async(client)=>{
      const found=await client.query("SELECT * FROM tenant_applications WHERE id=$1 FOR UPDATE",[applicationId]);
      if(!found.rowCount) notFound("Tenant application not found");
      if(found.rows[0].status!=="PENDING"){ const e=new Error("Application was already reviewed");e.statusCode=409;e.code="APPLICATION_FINAL";throw e; }
      let tenantId=null;
      if(body.action==="APPROVE"){
        const tenant=await client.query("INSERT INTO tenants(name,status,plan,approved_at) VALUES($1,'ACTIVE',$2,now()) RETURNING id",[found.rows[0].company_name,body.plan]);
        tenantId=tenant.rows[0].id;
        const organization=await client.query("INSERT INTO organizations(tenant_id,type,name) VALUES($1,'BRAND',$2) RETURNING id",[tenantId,found.rows[0].company_name]);
        await client.query("INSERT INTO local_organizations(id,tenant_id,name) VALUES($1,$2,$3)",[organization.rows[0].id,tenantId,found.rows[0].company_name]);
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
      return {value:changed.rows[0]};
    });
    return reply.code(response.status).send(response.body);
  });

  app.post("/api/v1/platform/tenants/:id/owner",async(request,reply)=>{
    requireCapability(request.principal,"platform:tenants:write");const tenantId=uuid.parse(request.params.id);
    const body=z.object({applicationId:uuid,username:z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u),temporaryPassword:z.string().min(12).max(200).refine(value=>/\p{L}/u.test(value)&&/\p{N}/u.test(value),"Password must contain letters and numbers"),reason}).parse(request.body);
    const input={tenantId,applicationId:body.applicationId,username:body.username,reason:body.reason,passwordDigest:hashToken(body.temporaryPassword)};
    const response=await platformCommand(db,request,"TENANT_OWNER_PROVISION",input,async(client)=>{const tenant=await client.query(`SELECT t.id,t.status,a.contact_email,o.id organization_id,o.name organization_name
       FROM tenants t JOIN tenant_applications a ON a.tenant_id=t.id AND a.id=$2
       JOIN organizations o ON o.tenant_id=t.id AND o.type='BRAND' WHERE t.id=$1 AND a.status='APPROVED' FOR UPDATE OF t`,[tenantId,body.applicationId]);if(!tenant.rowCount)notFound("Approved tenant not found");if(tenant.rows[0].status!=="ACTIVE"){const e=new Error("Tenant is not active");e.statusCode=409;e.code="TENANT_INACTIVE";throw e;}const userId=randomUuid();const normalizedUsername=body.username.toLowerCase();const normalizedContact=String(tenant.rows[0].contact_email).toLowerCase();const created=await client.query(`INSERT INTO local_users(id,username,normalized_username,email,normalized_email,password_hash,tenant_id,organization_id,role)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'TENANT_OWNER') ON CONFLICT DO NOTHING RETURNING id,username,email,tenant_id,organization_id,role`,[userId,body.username,normalizedUsername,tenant.rows[0].contact_email,normalizedContact,hashPassword(body.temporaryPassword),tenantId,tenant.rows[0].organization_id]);if(!created.rowCount){const e=new Error("Owner username or email already exists");e.statusCode=409;e.code="ACCOUNT_EXISTS";throw e;}await client.query("INSERT INTO local_memberships(id,user_id,organization_id,role) VALUES($1,$2,$3,'TENANT_OWNER')",[randomUuid(),userId,tenant.rows[0].organization_id]);await client.query("UPDATE local_organizations SET owner_user_id=$1 WHERE id=$2",[userId,tenant.rows[0].organization_id]);await client.query(`INSERT INTO platform_audit_log(actor_id,action,entity_type,entity_id,reason,request_id,after_state) VALUES($1,'TENANT_OWNER_PROVISION','LOCAL_USER',$2,$3,$4,$5)`,[request.principal.id,userId,body.reason,request.id,{tenantId,email:tenant.rows[0].contact_email,role:"TENANT_OWNER"}]);return{status:201,value:created.rows[0]};});return reply.code(response.status).send(response.body);
  });

  app.post("/api/v1/platform/tenants/:id/status",async(request,reply)=>{requireCapability(request.principal,"platform:tenants:write");const tenantId=uuid.parse(request.params.id),body=z.object({status:z.enum(["ACTIVE","SUSPENDED"]),reason}).parse(request.body);const response=await platformCommand(db,request,"TENANT_STATUS_CHANGE",{tenantId,...body},async client=>{const found=await client.query("SELECT id,name,status,plan,suspended_reason FROM tenants WHERE id=$1 FOR UPDATE",[tenantId]);if(!found.rowCount)notFound("Tenant not found");if(found.rows[0].status===body.status){const error=new Error("Tenant already has the requested status");error.statusCode=409;error.code="INVALID_STATE";throw error;}const changed=await client.query("UPDATE tenants SET status=$1,suspended_reason=$2 WHERE id=$3 RETURNING id,name,status,plan,suspended_reason",[body.status,body.status==="SUSPENDED"?body.reason:null,tenantId]);if(body.status==="SUSPENDED")await client.query("UPDATE admin_sessions SET revoked_at=now(),revoked_by=$1,revocation_reason=$2 WHERE tenant_id=$3 AND revoked_at IS NULL",[request.principal.id,body.reason,tenantId]);await client.query(`INSERT INTO platform_audit_log(actor_id,action,entity_type,entity_id,reason,request_id,before_state,after_state) VALUES($1,'TENANT_STATUS_CHANGE','TENANT',$2,$3,$4,$5,$6)`,[request.principal.id,tenantId,body.reason,request.id,found.rows[0],changed.rows[0]]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);});

  app.get("/api/v1/tenant/gs1-settings",async(request)=>{
    requireCapability(request.principal,"tenant:manage");
    const result=await db.query("SELECT gs1_company_prefix,sscc_next_reference,updated_at FROM tenant_settings WHERE tenant_id=$1",[request.principal.tenantId]);
    if(!result.rowCount)notFound("Tenant settings not found");
    const row=result.rows[0],prefix=row.gs1_company_prefix;
    return{gs1CompanyPrefix:prefix,ssccNextReference:String(row.sscc_next_reference),ssccCapacity:prefix?ssccCapacity(prefix).toString():null,updatedAt:row.updated_at};
  });
  app.post("/api/v1/tenant/gs1-settings",async(request,reply)=>{
    requireCapability(request.principal,"tenant:manage");
    const body=z.object({gs1CompanyPrefix:z.string().regex(/^\d{4,12}$/),auditReason:reason}).parse(request.body);
    const response=await command(db,request,"TENANT_GS1_SETTINGS_UPDATE",body,async client=>{
      const found=await client.query("SELECT gs1_company_prefix,sscc_next_reference,updated_at FROM tenant_settings WHERE tenant_id=$1 FOR UPDATE",[request.principal.tenantId]);
      if(!found.rowCount)notFound("Tenant settings not found");
      if(BigInt(found.rows[0].sscc_next_reference)>0n&&found.rows[0].gs1_company_prefix&&found.rows[0].gs1_company_prefix!==body.gs1CompanyPrefix){const error=new Error("GS1 Company Prefix cannot change after SSCC allocation has started");error.statusCode=409;error.code="GS1_PREFIX_LOCKED";throw error;}
      const changed=await client.query("UPDATE tenant_settings SET gs1_company_prefix=$1,updated_at=now() WHERE tenant_id=$2 RETURNING gs1_company_prefix,sscc_next_reference,updated_at",[body.gs1CompanyPrefix,request.principal.tenantId]);
      await tenantAudit(client,request,"TENANT_GS1_SETTINGS_UPDATE","TENANT_SETTINGS",request.principal.tenantId,found.rows[0],changed.rows[0]);
      const row=changed.rows[0];return{value:{gs1CompanyPrefix:row.gs1_company_prefix,ssccNextReference:String(row.sscc_next_reference),ssccCapacity:ssccCapacity(row.gs1_company_prefix).toString(),updatedAt:row.updated_at}};
    });return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/products", async (request) => {
    requireCapability(request.principal,"objects:read");
    const query=pageQuery.extend({ status:z.enum(["ACTIVE","INACTIVE"]).optional(), q:z.string().trim().max(100).optional() }).parse(request.query);
    const cursor=cursorDecode(query.cursor);
    const result=await db.query(
      `SELECT id,sku,gtin,name,status,created_at,COALESCE((SELECT jsonb_object_agg(level,gtin) FROM product_trade_items pti WHERE pti.tenant_id=products.tenant_id AND pti.product_id=products.id),'{}'::jsonb) trade_items FROM products WHERE tenant_id=$1
       AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR sku ILIKE '%'||$3||'%' OR name ILIKE '%'||$3||'%')
       AND ($4::timestamptz IS NULL OR (created_at,id)<($4,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6`,
      [request.principal.tenantId,query.status||null,query.q||null,cursor?.[0]||null,cursor?.[1]||null,query.limit+1]
    );
    return page(result.rows,query.limit);
  });

  app.post("/api/v1/products", async (request,reply) => {
    requireCapability(request.principal,"products:write");
    const body=z.object({ sku:z.string().trim().min(1).max(80), gtin:z.string().refine(isValidGtin,"GTIN must be a valid 8, 12, 13, or 14 digit GS1 key including its check digit").optional(),caseGtin:z.string().refine(isValidGtin,"Case GTIN must be a valid GS1 key including its check digit").optional(), name:z.string().trim().min(1).max(160), auditReason:reason }).refine(value=>!value.gtin||!value.caseGtin||value.gtin!==value.caseGtin,{path:["caseGtin"],message:"Item and case trade items require different GTINs"}).parse(request.body);
    const response=await command(db,request,"PRODUCT_CREATE",body,async(client)=>{
      let created;try{created=await client.query("INSERT INTO products(tenant_id,sku,gtin,name) VALUES($1,$2,$3,$4) RETURNING *",[request.principal.tenantId,body.sku,body.gtin||null,body.name]);
        for(const [level,gtin] of [["ITEM",body.gtin],["CASE",body.caseGtin]])if(gtin)await client.query("INSERT INTO product_trade_items(tenant_id,product_id,level,gtin,created_by) VALUES($1,$2,$3,$4,$5)",[request.principal.tenantId,created.rows[0].id,level,gtin,request.principal.id]);
      }catch(error){rethrowUnique(error,"PRODUCT_IDENTIFIER_EXISTS","The SKU or packaging GTIN is already assigned in this tenant");}
      const value={...created.rows[0],trade_items:Object.fromEntries([["ITEM",body.gtin],["CASE",body.caseGtin]].filter(([,gtin])=>gtin))};await tenantAudit(client,request,"PRODUCT_CREATE","PRODUCT",created.rows[0].id,null,value);
      return {status:201,value};
    });
    return reply.code(response.status).send(response.body);
  });

  app.post("/api/v1/products/:id/trade-items",async(request,reply)=>{
    requireCapability(request.principal,"products:write");const productId=uuid.parse(request.params.id);
    const body=z.object({level:z.enum(["ITEM","CASE"]),gtin:z.string().refine(isValidGtin,"GTIN must be a valid GS1 key including its check digit"),auditReason:reason}).parse(request.body);
    const response=await command(db,request,"PRODUCT_TRADE_ITEM_SET",{productId,...body},async client=>{
      const product=await client.query("SELECT id FROM products WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",[request.principal.tenantId,productId]);if(!product.rowCount)notFound("Product not found");
      const found=await client.query("SELECT * FROM product_trade_items WHERE tenant_id=$1 AND product_id=$2 AND level=$3 FOR UPDATE",[request.principal.tenantId,productId,body.level]);
      if(found.rowCount&&found.rows[0].gtin!==body.gtin){const used=await client.query("SELECT 1 FROM code_generation_jobs WHERE tenant_id=$1 AND product_id=$2 AND level=$3 LIMIT 1",[request.principal.tenantId,productId,body.level]);if(used.rowCount){const error=new Error("A packaging GTIN cannot change after a code job has been created");error.statusCode=409;error.code="PACKAGING_GTIN_LOCKED";throw error;}}
      let changed;try{changed=await client.query(`INSERT INTO product_trade_items(tenant_id,product_id,level,gtin,created_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id,product_id,level) DO UPDATE SET gtin=EXCLUDED.gtin,updated_at=now() RETURNING *`,[request.principal.tenantId,productId,body.level,body.gtin,request.principal.id]);}catch(error){rethrowUnique(error,"PACKAGING_GTIN_EXISTS","The packaging GTIN is already assigned in this tenant");}
      if(body.level==="ITEM")await client.query("UPDATE products SET gtin=$1 WHERE tenant_id=$2 AND id=$3",[body.gtin,request.principal.tenantId,productId]);
      await tenantAudit(client,request,"PRODUCT_TRADE_ITEM_SET","PRODUCT",productId,found.rows[0]||null,changed.rows[0]);return{value:changed.rows[0]};
    });return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/locations", async (request) => {
    requireCapability(request.principal,"objects:read");
    const result=await db.query("SELECT * FROM locations WHERE tenant_id=$1 ORDER BY created_at DESC",[request.principal.tenantId]);
    return {items:result.rows};
  });
  app.get("/api/v1/organizations",async(request)=>{
    requireAnyCapability(request.principal,["documents:write","members:read","events:read"]);
    const result=await db.query("SELECT id,name,type,status,created_at FROM organizations WHERE tenant_id=$1 ORDER BY name,id",[request.principal.tenantId]);return{items:result.rows};
  });
  app.post("/api/v1/locations", async(request,reply)=>{
    requireCapability(request.principal,"locations:write");
    const body=z.object({ organizationId:uuid,code:z.string().trim().min(1).max(80),gln:z.string().refine(isValidGln,"GLN must be a valid 13 digit GS1 key including its check digit").optional(),name:z.string().trim().min(1).max(160),type:z.enum(["FACTORY","WAREHOUSE","DISTRIBUTOR","STORE","OFFICE"]),city:z.string().max(80).optional(),region:z.string().max(80).optional(),auditReason:reason }).parse(request.body);
    const response=await command(db,request,"LOCATION_CREATE",body,async(client)=>{
      const org=await client.query("SELECT 1 FROM organizations WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,body.organizationId]); if(!org.rowCount) notFound();
      const created=await client.query("INSERT INTO locations(tenant_id,organization_id,code,gln,name,type,city,region) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[request.principal.tenantId,body.organizationId,body.code,body.gln||null,body.name,body.type,body.city||null,body.region||null]);
      await tenantAudit(client,request,"LOCATION_CREATE","LOCATION",created.rows[0].id,null,created.rows[0]); return {status:201,value:created.rows[0]};
    }); return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/devices",async(request)=>{requireCapability(request.principal,"objects:read");const result=await db.query(`SELECT id,tenant_id,organization_id,location_id,name,public_key,allowed_event_types,status,last_seen_at,revoked_at,revoked_by,created_at
    FROM devices WHERE tenant_id=$1 ORDER BY created_at DESC`,[request.principal.tenantId]);return{items:result.rows};});
  app.post("/api/v1/devices",async(request,reply)=>{
    requireCapability(request.principal,"devices:write");const body=z.object({organizationId:uuid,locationId:uuid,name:z.string().trim().min(1).max(120),publicKey:z.string().max(8000).optional(),allowedEventTypes:z.array(deviceEventType).min(1).max(8),auditReason:reason}).parse(request.body);
    const key=parseIdempotencyKey(request),hash=requestHash("DEVICE_REGISTER",body),response=await tx(db,async client=>{await lockIdempotencyKey(client,request.principal.tenantId,key);const cached=await getIdempotentResponse(client,request.principal.tenantId,key,hash);if(cached)return cached;const location=await client.query("SELECT gln FROM locations WHERE tenant_id=$1 AND id=$2 AND organization_id=$3 AND status='ACTIVE'",[request.principal.tenantId,body.locationId,body.organizationId]);if(!location.rowCount)notFound("Location not found");if(!isValidGln(location.rows[0].gln)){const error=new Error("A valid GLN is required before a location can bind a production device");error.statusCode=409;error.code="LOCATION_GLN_REQUIRED";throw error;}const deviceToken=randomBytes(32).toString("base64url"),created=await client.query(`INSERT INTO devices(tenant_id,organization_id,location_id,name,public_key,credential_hash,allowed_event_types)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,tenant_id,organization_id,location_id,name,public_key,allowed_event_types,status,created_at`,[request.principal.tenantId,body.organizationId,body.locationId,body.name,body.publicKey||null,hashToken(deviceToken),[...new Set(body.allowedEventTypes)]]);await tenantAudit(client,request,"DEVICE_REGISTER","DEVICE",created.rows[0].id,null,created.rows[0]);const stored={device:created.rows[0],deviceToken:null,credentialPreviouslyIssued:true};await saveIdempotentResponse(client,{tenantId:request.principal.tenantId,key,operation:"DEVICE_REGISTER",hash,status:201,body:stored});return{status:201,body:{device:created.rows[0],deviceToken,credentialPreviouslyIssued:false}};});return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/devices/:id/revoke",async(request,reply)=>{
    requireCapability(request.principal,"devices:write");const id=uuid.parse(request.params.id),body=z.object({auditReason:reason}).parse(request.body),safeColumns="id,tenant_id,organization_id,location_id,name,public_key,allowed_event_types,status,last_seen_at,revoked_at,revoked_by,created_at";const response=await command(db,request,"DEVICE_REVOKE",{id,...body},async(client)=>{const found=await client.query(`SELECT ${safeColumns} FROM devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[request.principal.tenantId,id]);if(!found.rowCount)notFound();if(found.rows[0].status==="REVOKED")return{value:found.rows[0]};const changed=await client.query(`UPDATE devices SET status='REVOKED',revoked_at=now(),revoked_by=$1 WHERE tenant_id=$2 AND id=$3 RETURNING ${safeColumns}`,[request.principal.id,request.principal.tenantId,id]);await tenantAudit(client,request,"DEVICE_REVOKE","DEVICE",id,found.rows[0],changed.rows[0]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/documents",async(request)=>{requireAnyCapability(request.principal,["events:read","events:write:packing","events:write:unpacking","events:write:shipping","events:write:distributor_receiving","events:write:store_receiving","events:write:returning","events:write:selling","events:write:destroying"]);const result=await db.query("SELECT * FROM business_documents WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200",[request.principal.tenantId]);return{items:result.rows};});
  app.get("/api/v1/trace-events",async(request)=>{
    requireCapability(request.principal,"events:read");const query=pageQuery.extend({eventType:deviceEventType.or(z.literal("VERIFY")).optional(),objectCode:z.string().trim().min(6).max(200).transform(value=>value.toUpperCase()).optional(),documentId:uuid.optional()}).parse(request.query),cursor=cursorDecode(query.cursor);
    const result=await db.query(`SELECT te.id,te.event_type,te.event_time,te.record_time,te.read_point,te.verification_status,te.organization_id,te.device_id,te.location_id,te.business_document_id,
      so.code object_code,so.level object_level,p.sku,p.name product_name
      FROM trace_events te JOIN serialized_objects so ON so.tenant_id=te.tenant_id AND so.id=te.object_id JOIN products p ON p.tenant_id=so.tenant_id AND p.id=so.product_id
      WHERE te.tenant_id=$1 AND ($2::text IS NULL OR te.event_type=$2) AND ($3::text IS NULL OR so.code=$3) AND ($4::uuid IS NULL OR te.business_document_id=$4)
        AND ($5::timestamptz IS NULL OR (te.record_time,te.id)<($5,$6::uuid)) ORDER BY te.record_time DESC,te.id DESC LIMIT $7`,[request.principal.tenantId,query.eventType||null,query.objectCode||null,query.documentId||null,cursor?.[0]||null,cursor?.[1]||null,query.limit+1]);
    const hasMore=result.rows.length>query.limit,items=hasMore?result.rows.slice(0,query.limit):result.rows,nextCursor=hasMore?Buffer.from(JSON.stringify([items.at(-1).record_time,items.at(-1).id])).toString("base64url"):null;return{items,nextCursor};
  });
  app.post("/api/v1/documents",async(request,reply)=>{
    requireCapability(request.principal,"documents:write");const body=z.object({documentType:z.enum(["PRODUCTION_ORDER","PACKING_ORDER","SHIPMENT","RECEIPT","SALE","RETURN","DESTRUCTION"]),reference:z.string().trim().min(1).max(120),fromOrganizationId:uuid.optional(),toOrganizationId:uuid.optional(),metadata:z.record(z.string(),z.unknown()).default({}),auditReason:reason}).superRefine((value,ctx)=>{if(["PRODUCTION_ORDER","PACKING_ORDER","SHIPMENT","SALE","RETURN","DESTRUCTION"].includes(value.documentType)&&!value.fromOrganizationId)ctx.addIssue({code:"custom",path:["fromOrganizationId"],message:"Source organization is required"});if(["SHIPMENT","RECEIPT"].includes(value.documentType)&&!value.toOrganizationId)ctx.addIssue({code:"custom",path:["toOrganizationId"],message:"Destination organization is required"});}).parse(request.body);
    const response=await command(db,request,"DOCUMENT_CREATE",body,async(client)=>{for(const orgId of [body.fromOrganizationId,body.toOrganizationId].filter(Boolean)){const org=await client.query("SELECT 1 FROM organizations WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,orgId]);if(!org.rowCount)notFound("Organization not found");}const created=await client.query(`INSERT INTO business_documents(tenant_id,document_type,reference,from_organization_id,to_organization_id,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[request.principal.tenantId,body.documentType,body.reference,body.fromOrganizationId||null,body.toOrganizationId||null,body.metadata,request.principal.id]);await tenantAudit(client,request,"DOCUMENT_CREATE","BUSINESS_DOCUMENT",created.rows[0].id,null,created.rows[0]);return{status:201,value:created.rows[0]};});return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/documents/:id/transition",async(request,reply)=>{
    requireCapability(request.principal,"documents:write");const id=uuid.parse(request.params.id),body=z.object({expectedVersion:z.number().int().min(0),status:z.enum(["APPROVED","IN_PROGRESS","COMPLETED","CANCELLED"]),auditReason:reason}).parse(request.body);const response=await command(db,request,"DOCUMENT_TRANSITION",{id,...body},async(client)=>{const found=await client.query("SELECT * FROM business_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]);if(!found.rowCount)notFound();if(Number(found.rows[0].version)!==body.expectedVersion){const e=new Error("Document version changed");e.statusCode=409;e.code="VERSION_CONFLICT";throw e;}const allowed={DRAFT:["APPROVED","CANCELLED"],APPROVED:["IN_PROGRESS","CANCELLED"],IN_PROGRESS:["COMPLETED","CANCELLED"]};if(!allowed[found.rows[0].status]?.includes(body.status)){const e=new Error("Invalid document state transition");e.statusCode=409;e.code="INVALID_STATE";throw e;}if(body.status==="APPROVED"){const objects=await client.query("SELECT count(*)::int count FROM business_document_objects WHERE tenant_id=$1 AND document_id=$2 AND expected AND line_role='ACTION'",[request.principal.tenantId,id]);if(Number(objects.rows[0]?.count||0)<1){const e=new Error("At least one expected action object is required before document approval");e.statusCode=409;e.code="DOCUMENT_OBJECTS_REQUIRED";throw e;}}if(body.status==="COMPLETED"){const pending=await client.query("SELECT count(*)::int count FROM business_document_objects WHERE tenant_id=$1 AND document_id=$2 AND expected AND line_role='ACTION' AND fulfilled_event_id IS NULL",[request.principal.tenantId,id]);if(Number(pending.rows[0]?.count||0)>0){const e=new Error("Every expected action object must be fulfilled before document completion");e.statusCode=409;e.code="DOCUMENT_OBJECTS_PENDING";throw e;}}const changed=await client.query("UPDATE business_documents SET status=$1,version=version+1,updated_at=now() WHERE tenant_id=$2 AND id=$3 RETURNING *",[body.status,request.principal.tenantId,id]);await tenantAudit(client,request,"DOCUMENT_TRANSITION","BUSINESS_DOCUMENT",id,found.rows[0],changed.rows[0]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);
  });
  app.get("/api/v1/documents/:id/objects",async(request)=>{
    requireAnyCapability(request.principal,["events:read","events:write:packing","events:write:unpacking","events:write:shipping","events:write:distributor_receiving","events:write:store_receiving","events:write:returning","events:write:selling","events:write:destroying"]);const documentId=uuid.parse(request.params.id);
    const document=await db.query("SELECT 1 FROM business_documents WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,documentId]);if(!document.rowCount)notFound("Business document not found");
    const result=await db.query(`SELECT object_id,expected,line_role,object_snapshot,fulfilled_event_id,fulfilled_at,added_by,added_at FROM business_document_objects
      WHERE tenant_id=$1 AND document_id=$2 ORDER BY added_at,object_id`,[request.principal.tenantId,documentId]);return{items:result.rows};
  });
  app.post("/api/v1/documents/:id/objects",async(request,reply)=>{
    requireCapability(request.principal,"documents:write");const documentId=uuid.parse(request.params.id),body=z.object({objectCode:z.string().trim().min(6).max(200).transform(value=>value.toUpperCase()),expected:z.boolean().default(true),lineRole:z.enum(["ACTION","CONTEXT"]).default("ACTION"),auditReason:reason}).parse(request.body);
    const response=await command(db,request,"DOCUMENT_OBJECT_ADD",{documentId,...body},async client=>{
      const document=await client.query("SELECT * FROM business_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,documentId]);if(!document.rowCount)notFound("Business document not found");if(document.rows[0].status!=="DRAFT"){const error=new Error("Document objects can only change while the document is a draft");error.statusCode=409;error.code="DOCUMENT_NOT_DRAFT";throw error;}
      const object=await client.query("SELECT id,code,level,lot,status,parent_id,current_organization_id,product_id FROM serialized_objects WHERE tenant_id=$1 AND code=$2",[request.principal.tenantId,body.objectCode]);if(!object.rowCount)notFound("Serialized object not found");
      const snapshot=object.rows[0],created=await client.query(`INSERT INTO business_document_objects(tenant_id,document_id,object_id,expected,line_role,object_snapshot,added_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,document_id,object_id) DO UPDATE SET expected=EXCLUDED.expected,line_role=EXCLUDED.line_role,object_snapshot=EXCLUDED.object_snapshot,fulfilled_event_id=NULL,fulfilled_at=NULL,added_by=EXCLUDED.added_by,added_at=now() RETURNING *`,[request.principal.tenantId,documentId,snapshot.id,body.expected,body.lineRole,snapshot,request.principal.id]);
      await tenantAudit(client,request,"DOCUMENT_OBJECT_ADD","BUSINESS_DOCUMENT",documentId,null,created.rows[0]);return{status:201,value:created.rows[0]};
    });return reply.code(response.status).send(response.body);
  });
  app.delete("/api/v1/documents/:id/objects/:objectId",async(request,reply)=>{
    requireCapability(request.principal,"documents:write");const documentId=uuid.parse(request.params.id),objectId=uuid.parse(request.params.objectId),body=z.object({auditReason:reason}).parse(request.body);
    const response=await command(db,request,"DOCUMENT_OBJECT_REMOVE",{documentId,objectId,...body},async client=>{
      const document=await client.query("SELECT * FROM business_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,documentId]);if(!document.rowCount)notFound("Business document not found");if(document.rows[0].status!=="DRAFT"){const error=new Error("Document objects can only change while the document is a draft");error.statusCode=409;error.code="DOCUMENT_NOT_DRAFT";throw error;}
      const removed=await client.query("DELETE FROM business_document_objects WHERE tenant_id=$1 AND document_id=$2 AND object_id=$3 RETURNING *",[request.principal.tenantId,documentId,objectId]);if(!removed.rowCount)notFound("Document object not found");await tenantAudit(client,request,"DOCUMENT_OBJECT_REMOVE","BUSINESS_DOCUMENT",documentId,removed.rows[0],null);return{value:{removed:true,objectId}};
    });return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/code-jobs",async(request)=>{
    requireCapability(request.principal,"codes:write");const query=pageQuery.parse(request.query),cursor=cursorDecode(query.cursor);const result=await db.query(`SELECT id,product_id,code_batch_id,requested_by,approved_by,level,identifier_scheme,quantity,serial_rule,lot,status,generated_count,last_error,
      export_status,export_attempts,export_last_error,export_completed_at,output_size_bytes,output_sha256,created_at,started_at,completed_at
      FROM code_generation_jobs WHERE tenant_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $4`,[request.principal.tenantId,cursor?.[0]||null,cursor?.[1]||null,query.limit+1]);return page(result.rows,query.limit);
  });
  app.post("/api/v1/code-jobs",async(request,reply)=>{
    requireCapability(request.principal,"codes:write");
    const body=z.object({productId:uuid,level:z.enum(["ITEM","CASE","PALLET"]),quantity:z.number().int().min(1).max(1000000),serialRule:z.enum(["RANDOM","SEQUENTIAL"]),lot:z.string().trim().refine(value=>isValidGs1X(value),"Batch/lot must contain 1 to 20 GS1 X characters").optional(),auditReason:reason}).superRefine((value,ctx)=>{if(value.level==="PALLET"&&value.serialRule!=="SEQUENTIAL")ctx.addIssue({code:"custom",path:["serialRule"],message:"SSCC pallet allocation requires a sequential serial rule"});}).parse(request.body);
    const response=await command(db,request,"CODE_JOB_CREATE",body,async(client,key)=>{
      const product=await client.query(`SELECT 1 FROM products p WHERE p.tenant_id=$1 AND p.id=$2 AND p.status='ACTIVE'
        AND ($3='PALLET' OR EXISTS(SELECT 1 FROM product_trade_items pti WHERE pti.tenant_id=p.tenant_id AND pti.product_id=p.id AND pti.level=$3))`,[request.principal.tenantId,body.productId,body.level]); if(!product.rowCount) notFound("Product or packaging GTIN not found");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["code-quota:"+request.principal.tenantId]);
      const quota=await client.query(`SELECT COALESCE(s.max_monthly_codes,10000)::bigint max_codes,COALESCE(u.code_count,0)::bigint used_codes
        FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id=t.id LEFT JOIN tenant_usage_monthly u ON u.tenant_id=t.id AND u.usage_month=date_trunc('month',now())::date WHERE t.id=$1`,[request.principal.tenantId]);
      if(BigInt(quota.rows[0]?.used_codes||0)+BigInt(body.quantity)>BigInt(quota.rows[0]?.max_codes||0)){await client.query(`INSERT INTO tenant_entitlement_audit(tenant_id,actor_id,action,usage_month,usage_delta,reason_code,request_id) VALUES($1,$2,'QUOTA_BLOCKED',date_trunc('month',now())::date,$3,'MONTHLY_CODE_LIMIT',$4)`,[request.principal.tenantId,request.principal.id,{requestedCodes:body.quantity},request.id]);return{status:429,value:{code:"MONTHLY_CODE_LIMIT",message:"Monthly code quota would be exceeded"}};}
      await client.query(`INSERT INTO tenant_usage_monthly(tenant_id,usage_month,code_count) VALUES($1,date_trunc('month',now())::date,$2)
        ON CONFLICT(tenant_id,usage_month) DO UPDATE SET code_count=tenant_usage_monthly.code_count+EXCLUDED.code_count,updated_at=now()`,[request.principal.tenantId,body.quantity]);
      const created=await client.query(`INSERT INTO code_generation_jobs(tenant_id,product_id,requested_by,level,quantity,serial_rule,lot,idempotency_key,identifier_scheme) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[request.principal.tenantId,body.productId,request.principal.id,body.level,body.quantity,body.serialRule,body.lot||null,key,body.level==="PALLET"?"SSCC":"SGTIN"]);
      await tenantAudit(client,request,"CODE_JOB_CREATE","CODE_GENERATION_JOB",created.rows[0].id,null,created.rows[0]); return {status:202,value:created.rows[0]};
    }); return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/code-jobs/:id/approve",async(request,reply)=>{
    requireCapability(request.principal,"codes:approve"); const id=uuid.parse(request.params.id); const body=z.object({auditReason:reason}).parse(request.body);
    const response=await command(db,request,"CODE_JOB_APPROVE",{id,...body},async(client)=>{
      const found=await client.query("SELECT * FROM code_generation_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]); if(!found.rowCount) notFound();
      if(found.rows[0].status!=="PENDING_APPROVAL"){const e=new Error("Job cannot be approved in its current state");e.statusCode=409;e.code="INVALID_STATE";throw e;}
      let changed;
      if(found.rows[0].identifier_scheme==="SSCC"){
        const settings=await client.query("SELECT gs1_company_prefix,sscc_next_reference FROM tenant_settings WHERE tenant_id=$1 FOR UPDATE",[request.principal.tenantId]);
        const prefix=settings.rows[0]?.gs1_company_prefix;if(!prefix){const error=new Error("Configure the tenant GS1 Company Prefix before approving pallet codes");error.statusCode=409;error.code="GS1_COMPANY_PREFIX_REQUIRED";throw error;}
        const start=BigInt(settings.rows[0].sscc_next_reference),end=start+BigInt(found.rows[0].quantity),capacity=ssccCapacity(prefix);
        if(end>capacity){const error=new Error("The tenant SSCC serial reference capacity is exhausted");error.statusCode=409;error.code="SSCC_CAPACITY_EXHAUSTED";throw error;}
        await client.query("UPDATE tenant_settings SET sscc_next_reference=$1,updated_at=now() WHERE tenant_id=$2",[end.toString(),request.principal.tenantId]);
        changed=await client.query("UPDATE code_generation_jobs SET status='QUEUED',approved_by=$1,gs1_company_prefix_snapshot=$2,sscc_extension_digit=0,sscc_start_reference=$3 WHERE id=$4 RETURNING *",[request.principal.id,prefix,start.toString(),id]);
      }else if(found.rows[0].identifier_scheme==="SGTIN") changed=await client.query("UPDATE code_generation_jobs SET status='QUEUED',approved_by=$1 WHERE id=$2 RETURNING *",[request.principal.id,id]);
      else{const error=new Error("Legacy nonconforming pallet jobs cannot be approved");error.statusCode=409;error.code="NONCONFORMING_IDENTIFIER";throw error;}
      await tenantAudit(client,request,"CODE_JOB_APPROVE","CODE_GENERATION_JOB",id,found.rows[0],changed.rows[0]); return {value:changed.rows[0]};
    }); return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/code-jobs/:id/cancel",async(request,reply)=>{
    requireCapability(request.principal,"codes:write");const id=uuid.parse(request.params.id),body=z.object({auditReason:reason}).parse(request.body);
    const response=await command(db,request,"CODE_JOB_CANCEL",{id,...body},async(client)=>{const found=await client.query("SELECT * FROM code_generation_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]);if(!found.rowCount)notFound();if(!["PENDING_APPROVAL","QUEUED","RUNNING"].includes(found.rows[0].status)){const e=new Error("Job cannot be cancelled in its current state");e.statusCode=409;e.code="INVALID_STATE";throw e;}const changed=await client.query("UPDATE code_generation_jobs SET status='CANCELLED',completed_at=now() WHERE id=$1 RETURNING *",[id]);const release=Math.max(0,Number(found.rows[0].quantity)-Number(found.rows[0].generated_count));if(release)await client.query(`UPDATE tenant_usage_monthly SET code_count=GREATEST(0,code_count-$1),updated_at=now() WHERE tenant_id=$2 AND usage_month=date_trunc('month',now())::date`,[release,request.principal.tenantId]);await tenantAudit(client,request,"CODE_JOB_CANCEL","CODE_GENERATION_JOB",id,found.rows[0],changed.rows[0]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/code-jobs/:id/retry",async(request,reply)=>{
    requireCapability(request.principal,"codes:approve");const id=uuid.parse(request.params.id),body=z.object({auditReason:reason}).parse(request.body);
    const response=await command(db,request,"CODE_JOB_RETRY",{id,...body},async(client)=>{const found=await client.query("SELECT * FROM code_generation_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]);if(!found.rowCount)notFound();if(found.rows[0].status!=="FAILED"){const e=new Error("Only failed jobs can be retried");e.statusCode=409;e.code="INVALID_STATE";throw e;}const reserve=Math.max(0,Number(found.rows[0].quantity)-Number(found.rows[0].generated_count));await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["code-quota:"+request.principal.tenantId]);const quota=await client.query(`SELECT COALESCE(s.max_monthly_codes,10000)::bigint max_codes,COALESCE(u.code_count,0)::bigint used_codes FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id=t.id LEFT JOIN tenant_usage_monthly u ON u.tenant_id=t.id AND u.usage_month=date_trunc('month',now())::date WHERE t.id=$1`,[request.principal.tenantId]);if(BigInt(quota.rows[0]?.used_codes||0)+BigInt(reserve)>BigInt(quota.rows[0]?.max_codes||0))return{status:429,value:{code:"MONTHLY_CODE_LIMIT",message:"Monthly code quota would be exceeded"}};if(reserve)await client.query(`INSERT INTO tenant_usage_monthly(tenant_id,usage_month,code_count) VALUES($1,date_trunc('month',now())::date,$2) ON CONFLICT(tenant_id,usage_month) DO UPDATE SET code_count=tenant_usage_monthly.code_count+EXCLUDED.code_count,updated_at=now()`,[request.principal.tenantId,reserve]);const changed=await client.query("UPDATE code_generation_jobs SET status='QUEUED',last_error=NULL,completed_at=NULL,approved_by=$1 WHERE id=$2 RETURNING *",[request.principal.id,id]);await tenantAudit(client,request,"CODE_JOB_RETRY","CODE_GENERATION_JOB",id,found.rows[0],changed.rows[0]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/code-jobs/:id/export-retry",async(request,reply)=>{requireCapability(request.principal,"codes:approve");const id=uuid.parse(request.params.id),body=z.object({auditReason:reason}).parse(request.body);const response=await command(db,request,"CODE_EXPORT_RETRY",{id,...body},async client=>{const found=await client.query("SELECT * FROM code_generation_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]);if(!found.rowCount)notFound();if(found.rows[0].status!=="COMPLETED"||found.rows[0].export_status!=="DEAD_LETTER"){const error=new Error("Only dead-lettered exports can be retried");error.statusCode=409;error.code="INVALID_STATE";throw error;}const changed=await client.query("UPDATE code_generation_jobs SET export_status='PENDING',export_attempts=0,export_last_error=NULL,export_available_at=now(),export_locked_at=NULL WHERE tenant_id=$1 AND id=$2 RETURNING id,status,export_status,export_attempts",[request.principal.tenantId,id]);await tenantAudit(client,request,"CODE_EXPORT_RETRY","CODE_GENERATION_JOB",id,found.rows[0],changed.rows[0]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);});
  app.get("/api/v1/code-jobs/:id/download",{config:{rateLimit:{max:30,timeWindow:"1 minute"}}},async(request)=>{requireCapability(request.principal,"codes:write");const id=uuid.parse(request.params.id),result=await db.query("SELECT output_object_key,export_status FROM code_generation_jobs WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,id]);if(!result.rowCount)notFound();if(result.rows[0].export_status!=="COMPLETED"||!result.rows[0].output_object_key){const error=new Error("Code export is not ready");error.statusCode=409;error.code="EXPORT_NOT_READY";throw error;}const storage=createObjectStorage(config);try{const url=await presignCodeExport(storage,config,result.rows[0].output_object_key,{expiresIn:300});return{url,expiresAt:new Date(Date.now()+300000).toISOString()};}finally{storage.destroy();}});

  app.get("/api/v1/recalls",async(request)=>{requireCapability(request.principal,"events:read");const result=await db.query("SELECT * FROM recalls WHERE tenant_id=$1 ORDER BY created_at DESC",[request.principal.tenantId]);return {items:result.rows};});
  app.get("/api/v1/risk-cases",async(request)=>{requireCapability(request.principal,"risks:review");const query=pageQuery.extend({status:z.enum(["OPEN","HELD","APPROVED","REJECTED","CLOSED"]).optional(),severity:z.enum(["LOW","MEDIUM","HIGH","CRITICAL"]).optional()}).parse(request.query),cursor=cursorDecode(query.cursor);const result=await db.query(`SELECT rc.id,rc.trace_event_id,rc.claim_id,rc.risk_type,rc.severity,rc.status,rc.evidence,rc.created_at,rc.resolved_at,rc.resolution_reason,te.event_type,so.code object_code
    FROM risk_cases rc LEFT JOIN trace_events te ON te.tenant_id=rc.tenant_id AND te.id=rc.trace_event_id LEFT JOIN serialized_objects so ON so.tenant_id=te.tenant_id AND so.id=te.object_id
    WHERE rc.tenant_id=$1 AND ($2::text IS NULL OR rc.status=$2) AND ($3::text IS NULL OR rc.severity=$3) AND ($4::timestamptz IS NULL OR (rc.created_at,rc.id)<($4,$5::uuid)) ORDER BY rc.created_at DESC,rc.id DESC LIMIT $6`,[request.principal.tenantId,query.status||null,query.severity||null,cursor?.[0]||null,cursor?.[1]||null,query.limit+1]);return page(result.rows,query.limit);});
  app.post("/api/v1/recalls",async(request,reply)=>{
    requireCapability(request.principal,"recalls:write"); const body=z.object({reference:z.string().trim().min(1).max(100),title:z.string().trim().min(1).max(200),reason:reason,scope:z.object({productIds:z.array(uuid).max(100).default([]),lots:z.array(z.string().trim().min(1).max(120)).max(100).default([])}).refine(value=>value.productIds.length>0||value.lots.length>0,{message:"Recall scope must select at least one product or lot"}),auditReason:reason}).parse(request.body);
    const response=await command(db,request,"RECALL_CREATE",body,async(client)=>{const created=await client.query("INSERT INTO recalls(tenant_id,reference,title,reason,scope,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[request.principal.tenantId,body.reference,body.title,body.reason,body.scope,request.principal.id]);await tenantAudit(client,request,"RECALL_CREATE","RECALL",created.rows[0].id,null,created.rows[0]);return {status:201,value:created.rows[0]};});return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/recalls/:id/activate",async(request,reply)=>{
    requireCapability(request.principal,"recalls:write"); const id=uuid.parse(request.params.id); const body=z.object({auditReason:reason}).parse(request.body);
    const response=await command(db,request,"RECALL_ACTIVATE",{id,...body},async(client)=>{const found=await client.query("SELECT * FROM recalls WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]);if(!found.rowCount)notFound();if(found.rows[0].status!=="DRAFT"){const e=new Error("Recall is not a draft");e.statusCode=409;e.code="INVALID_STATE";throw e;}const snapshot=await client.query(`INSERT INTO recall_objects(recall_id,tenant_id,object_id,latest_status,latest_organization_id)
       SELECT $1,so.tenant_id,so.id,so.status,so.current_organization_id FROM serialized_objects so
       WHERE so.tenant_id=$2 AND ((jsonb_array_length($3::jsonb->'productIds')>0 AND ($3::jsonb->'productIds') ? so.product_id::text)
         OR (jsonb_array_length($3::jsonb->'lots')>0 AND ($3::jsonb->'lots') ? COALESCE(so.lot,'')))
       ON CONFLICT (recall_id,object_id) DO NOTHING RETURNING object_id`,[id,request.principal.tenantId,found.rows[0].scope]);if(!snapshot.rowCount){const e=new Error("Recall scope does not match any serialized object");e.statusCode=409;e.code="RECALL_SCOPE_EMPTY";throw e;}const changed=await client.query("UPDATE recalls SET status='ACTIVE',activated_by=$1,activated_at=now() WHERE tenant_id=$2 AND id=$3 RETURNING *",[request.principal.id,request.principal.tenantId,id]);const value={...changed.rows[0],objectCount:snapshot.rowCount};await enqueueWebhookDeliveries(client,request.principal.tenantId,"RECALL_ACTIVATED",{recallId:id,reference:value.reference,title:value.title,objectCount:snapshot.rowCount,activatedAt:value.activated_at});await tenantAudit(client,request,"RECALL_ACTIVATE","RECALL",id,found.rows[0],value);return {value};});return reply.code(response.status).send(response.body);
  });
  app.get("/api/v1/recalls/:id/objects",async(request)=>{requireCapability(request.principal,"events:read");const id=uuid.parse(request.params.id),query=pageQuery.parse(request.query),cursor=cursorDecode(query.cursor),recall=await db.query("SELECT 1 FROM recalls WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,id]);if(!recall.rowCount)notFound();const result=await db.query(`SELECT ro.object_id,ro.latest_status,ro.latest_organization_id,ro.acknowledged_at,so.code,so.level,so.lot,p.name product_name,p.sku FROM recall_objects ro JOIN serialized_objects so ON so.tenant_id=ro.tenant_id AND so.id=ro.object_id JOIN products p ON p.tenant_id=so.tenant_id AND p.id=so.product_id WHERE ro.tenant_id=$1 AND ro.recall_id=$2 AND ($3::uuid IS NULL OR ro.object_id>$3) ORDER BY ro.object_id LIMIT $4`,[request.principal.tenantId,id,cursor?.[1]||null,query.limit+1]);const hasMore=result.rows.length>query.limit,items=hasMore?result.rows.slice(0,query.limit):result.rows,nextCursor=hasMore?Buffer.from(JSON.stringify([null,items.at(-1).object_id])).toString("base64url"):null;return{items,nextCursor};});

  app.get("/api/v1/supply-relationships",async(request)=>{requireCapability(request.principal,"objects:read");const result=await db.query(`SELECT id,source_tenant_id,target_tenant_id,target_email,relationship_type,scopes,status,accepted_at,updated_at,created_at
     FROM supply_relationships WHERE source_tenant_id=$1 OR target_tenant_id=$1 ORDER BY created_at DESC`,[request.principal.tenantId]);return{items:result.rows};});
  app.post("/api/v1/supply-relationships",async(request,reply)=>{
    requireCapability(request.principal,"relationships:write"); const body=z.object({targetTenantId:uuid.optional(),targetEmail:email.optional(),relationshipType:z.enum(["MANUFACTURER","DISTRIBUTOR","RETAILER","LOGISTICS","SERVICE_PROVIDER"]),scopes:z.array(z.enum(["TRACE_READ","SHIPMENT_WRITE","RECEIPT_WRITE","RETURN_WRITE","RECALL_READ"])).min(1).max(10),auditReason:reason}).refine(v=>v.targetTenantId||v.targetEmail,{message:"A target tenant or email is required"}).parse(request.body);
    const response=await command(db,request,"RELATIONSHIP_INVITE",body,async(client)=>{const token=randomBytes(32).toString("base64url");const created=await client.query(`INSERT INTO supply_relationships(source_tenant_id,target_tenant_id,target_email,relationship_type,scopes,invitation_token_hash,invited_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,source_tenant_id,target_tenant_id,target_email,relationship_type,scopes,status,created_at`,[request.principal.tenantId,body.targetTenantId||null,body.targetEmail||null,body.relationshipType,body.scopes,hashToken(token),request.principal.id]);await tenantAudit(client,request,"RELATIONSHIP_INVITE","SUPPLY_RELATIONSHIP",created.rows[0].id,null,created.rows[0]);return {status:201,value:{relationship:created.rows[0],invitationToken:token}};});return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/supply-relationships/accept",async(request,reply)=>{
    requireCapability(request.principal,"relationships:write");const body=z.object({invitationToken:z.string().min(32).max(200),auditReason:reason}).parse(request.body);
    const response=await command(db,request,"RELATIONSHIP_ACCEPT",{tokenHash:hashToken(body.invitationToken),auditReason:body.auditReason},async(client)=>{const found=await client.query("SELECT * FROM supply_relationships WHERE invitation_token_hash=$1 AND status='INVITED' FOR UPDATE",[hashToken(body.invitationToken)]);if(!found.rowCount)notFound("Relationship invitation not found");const relationship=found.rows[0];if(relationship.source_tenant_id===request.principal.tenantId)notFound("Relationship invitation not found");if(relationship.target_tenant_id&&relationship.target_tenant_id!==request.principal.tenantId)notFound("Relationship invitation not found");if(relationship.target_email&&normalizedEmail(request.principal.email)!==normalizedEmail(relationship.target_email)&&!relationship.target_tenant_id)notFound("Relationship invitation not found");const changed=await client.query("UPDATE supply_relationships SET target_tenant_id=$1,status='ACTIVE',accepted_by=$2,accepted_at=now(),updated_at=now(),invitation_token_hash=NULL WHERE id=$3 RETURNING id,source_tenant_id,target_tenant_id,relationship_type,scopes,status,accepted_at,updated_at,created_at",[request.principal.tenantId,request.principal.id,relationship.id]);await tenantAudit(client,request,"RELATIONSHIP_ACCEPT","SUPPLY_RELATIONSHIP",relationship.id,relationship,changed.rows[0]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);
  });
  app.post("/api/v1/supply-relationships/:id/status",async(request,reply)=>{
    requireCapability(request.principal,"relationships:write");const id=uuid.parse(request.params.id),body=z.object({status:z.enum(["ACTIVE","PAUSED","REVOKED"]),auditReason:reason}).parse(request.body);
    const response=await command(db,request,"RELATIONSHIP_STATUS",{id,...body},async(client)=>{const found=await client.query("SELECT * FROM supply_relationships WHERE id=$1 AND source_tenant_id=$2 FOR UPDATE",[id,request.principal.tenantId]);if(!found.rowCount)notFound();const allowed={ACTIVE:["PAUSED","REVOKED"],PAUSED:["ACTIVE","REVOKED"]};if(!allowed[found.rows[0].status]?.includes(body.status)){const e=new Error("Invalid relationship state transition");e.statusCode=409;e.code="INVALID_STATE";throw e;}const changed=await client.query("UPDATE supply_relationships SET status=$1,updated_at=now() WHERE id=$2 RETURNING *",[body.status,id]);await tenantAudit(client,request,"RELATIONSHIP_STATUS","SUPPLY_RELATIONSHIP",id,found.rows[0],changed.rows[0]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);
  });

  app.get("/api/v1/integrations/epcis/dead-letters",async(request)=>{requireCapability(request.principal,"integrations:write");const result=await db.query(`SELECT id,event_type,aggregate_type,aggregate_id,attempts,last_error,created_at,dead_lettered_at
     FROM event_outbox WHERE tenant_id=$1 AND dead_lettered_at IS NOT NULL AND processed_at IS NULL ORDER BY dead_lettered_at DESC LIMIT 200`,[request.principal.tenantId]);return{items:result.rows};});
  app.post("/api/v1/integrations/epcis/dead-letters/:id/replay-requests",async(request,reply)=>{requireCapability(request.principal,"integrations:write");const id=uuid.parse(request.params.id),body=z.object({reason}).parse(request.body);const response=await command(db,request,"EPCIS_REPLAY_REQUEST",{id,...body},async(client)=>{const outbox=await client.query("SELECT * FROM event_outbox WHERE tenant_id=$1 AND id=$2 AND dead_lettered_at IS NOT NULL AND processed_at IS NULL",[request.principal.tenantId,id]);if(!outbox.rowCount)notFound("Dead letter not found");const created=await client.query("INSERT INTO epcis_replay_requests(tenant_id,outbox_id,reason,requested_by) VALUES($1,$2,$3,$4) RETURNING *",[request.principal.tenantId,id,body.reason,request.principal.id]);await tenantAudit(client,request,"EPCIS_REPLAY_REQUEST","EVENT_OUTBOX",id,outbox.rows[0],created.rows[0]);return{status:201,value:created.rows[0]};});return reply.code(response.status).send(response.body);});
  app.post("/api/v1/integrations/epcis/replay-requests/:id/decision",async(request,reply)=>{requireCapability(request.principal,"integrations:approve");const id=uuid.parse(request.params.id),body=z.object({action:z.enum(["APPROVE","REJECT"]),reason}).parse(request.body);const response=await command(db,request,"EPCIS_REPLAY_DECISION",{id,...body},async(client)=>{const found=await client.query("SELECT * FROM epcis_replay_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,id]);if(!found.rowCount)notFound();if(found.rows[0].status!=="PENDING"){const e=new Error("Replay request was already reviewed");e.statusCode=409;e.code="INVALID_STATE";throw e;}if(found.rows[0].requested_by===request.principal.id){const e=new Error("Replay requests require a different approver");e.statusCode=409;e.code="DUAL_CONTROL_REQUIRED";throw e;}const status=body.action==="APPROVE"?"APPROVED":"REJECTED";const changed=await client.query("UPDATE epcis_replay_requests SET status=$1,reviewed_by=$2,review_reason=$3,reviewed_at=now() WHERE id=$4 RETURNING *",[status,request.principal.id,body.reason,id]);if(status==="APPROVED")await client.query("UPDATE event_outbox SET dead_lettered_at=NULL,attempts=0,last_error=NULL,available_at=now(),locked_at=NULL WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,found.rows[0].outbox_id]);await tenantAudit(client,request,"EPCIS_REPLAY_DECISION","EPCIS_REPLAY_REQUEST",id,found.rows[0],changed.rows[0]);return{value:changed.rows[0]};});return reply.code(response.status).send(response.body);});
}

function normalizedEmail(value){return String(value||"").trim().toLowerCase();}
