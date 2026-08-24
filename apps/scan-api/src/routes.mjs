import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requireCapability } from "./auth.mjs";
import { eventCapability, nextObjectStatus, verificationForEvent } from "./domain.mjs";
import { getIdempotentResponse, lockIdempotencyKey, requestHash, saveIdempotentResponse } from "./idempotency.mjs";
import { codeBatchSchema, parseIdempotencyKey, riskDecisionSchema, traceEventSchema } from "./schemas.mjs";

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

export function registerRoutes(app, { db }) {
  app.get("/api/public/v1/objects/:publicId", async (request, reply) => {
    const publicId = z.string().uuid().parse(request.params.publicId);
    const result = await db.query(
      `SELECT so.id,so.public_id,so.level,so.lot,so.status,so.created_at,p.gtin,p.name product_name
       FROM serialized_objects so JOIN products p ON p.id=so.product_id
       WHERE so.public_id=$1 AND p.status='ACTIVE'`,
      [publicId]
    );
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
      object:{ publicId:object.public_id, level:object.level, lot:object.lot, status:object.status, commissionedAt:object.created_at },
      events:events.rows.map((event) => ({ type:event.event_type, time:event.event_time }))
    };
  });

  app.get("/api/v1/me", async (request) => ({
    id: request.principal.id,
    name: request.principal.name,
    tenantId: request.principal.tenantId,
    organizationId: request.principal.organizationId,
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
    requireCapability(request.principal, "codes:write");
    const body = codeBatchSchema.parse(request.body);
    const key = parseIdempotencyKey(request);
    const operation = "CREATE_CODE_BATCH";
    const hash = requestHash(operation, body);
    const response = await db.transaction(async (client) => {
      await lockIdempotencyKey(client, request.principal.tenantId, key);
      const cached = await getIdempotentResponse(client, request.principal.tenantId, key, hash);
      if (cached) return cached;
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
      const found = await client.query(
        `SELECT so.*,p.sku,p.gtin,p.name product_name FROM serialized_objects so JOIN products p ON p.id=so.product_id
         WHERE so.tenant_id=$1 AND so.code=$2 FOR UPDATE OF so`,
        [request.principal.tenantId, body.objectCode]
      );
      if (!found.rowCount) { const error=new Error("Reliable code not found");error.statusCode=404;error.code="OBJECT_NOT_FOUND";throw error; }
      const object = found.rows[0];
      let shipment = null;
      if (body.shipmentId) {
        const shipmentResult = await client.query(
          `SELECT s.*,EXISTS(SELECT 1 FROM shipment_objects x WHERE x.shipment_id=s.id AND x.object_id=$3 AND x.expected) expected_object
           FROM shipments s WHERE s.tenant_id=$1 AND s.id=$2 FOR UPDATE`,
          [request.principal.tenantId, body.shipmentId, object.id]
        );
        shipment = shipmentResult.rows[0] || null;
      }
      const verification = verificationForEvent({ eventType:body.eventType, shipment, object, principal:request.principal });
      if (verification.status === "REJECTED") {
        const error = new Error(`Event rejected: ${verification.risk.type}`); error.statusCode=409; error.code=verification.risk.type; throw error;
      }
      const nextStatus = nextObjectStatus(body.eventType, object.level, object.status);
      const event = await client.query(
        `INSERT INTO trace_events(tenant_id,event_type,object_id,shipment_id,actor_id,actor_role,organization_id,event_time,read_point,verification_status,metadata,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [request.principal.tenantId,body.eventType,object.id,body.shipmentId||null,request.principal.id,request.principal.role,request.principal.organizationId,body.eventTime,body.readPoint,verification.status,body.metadata,key]
      );
      await client.query(
        `INSERT INTO event_outbox(tenant_id,aggregate_type,aggregate_id,event_type,payload)
         VALUES($1,'SERIALIZED_OBJECT',$2,'TRACE_EVENT_CAPTURED',$3)`,
        [request.principal.tenantId,object.id,{ event:event.rows[0], object:{ id:object.id, code:object.code, level:object.level, productId:object.product_id } }]
      );
      if (body.eventType !== "VERIFY" && verification.status === "VERIFIED") {
        await client.query("UPDATE serialized_objects SET status=$1,current_organization_id=$2 WHERE id=$3", [nextStatus, request.principal.organizationId, object.id]);
      }
      let riskCase = null;
      if (verification.risk) {
        const risk = await client.query(
          `INSERT INTO risk_cases(tenant_id,trace_event_id,risk_type,severity,evidence)
           VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [request.principal.tenantId,event.rows[0].id,verification.risk.type,verification.risk.severity,{objectCode:body.objectCode,shipmentId:body.shipmentId}]
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
      const result = { event:event.rows[0], object:{...object,status:nextStatus}, riskCase, reward };
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
