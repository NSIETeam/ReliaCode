import { randomUUID } from "node:crypto";
import { isValidGtin } from "./gs1.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const asUuid = (value) => typeof value === "string" && UUID.test(value) ? value : null;
const text = (value, max = 1024) => typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
const list = (value) => Array.isArray(value) ? value : [];

// Accept a mapping only when both sides are already established with the
// exact same tenant. Never infer identity from names, emails, or JSONB ids.
export function resolveSafeMapping(localOrg, rows) {
  const candidates = list(rows).filter((row) =>
    asUuid(row.local_organization_id) === localOrg.id &&
    asUuid(row.local_tenant_id) === localOrg.tenant_id &&
    asUuid(row.core_tenant_id) && asUuid(row.core_organization_id) &&
    row.core_tenant_id === localOrg.tenant_id && row.core_organization_tenant_id === row.core_tenant_id
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function productPlan(item, tenantId, stats) {
  stats.productsSeen++;
  const id = asUuid(item?.id), sku = text(item?.sku || item?.code, 160), name = text(item?.name, 240), gtin = text(item?.gtin, 80);
  if (!id || !sku || !name || (gtin && !isValidGtin(gtin))) { stats.skippedInvalid++; return null; }
  return { sql: `INSERT INTO products(id,tenant_id,sku,gtin,name) VALUES($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,sku) DO UPDATE SET gtin=COALESCE(products.gtin,EXCLUDED.gtin),name=COALESCE(products.name,EXCLUDED.name) WHERE products.id=EXCLUDED.id`, params: [id, tenantId, sku, gtin, name] };
}

function objectPlan(item, tenantId, productIds, organizationId, stats) {
  stats.objectsSeen++;
  const id = asUuid(item?.id), productId = asUuid(item?.productId), code = text(item?.code, 240), level = ['ITEM','CASE','PALLET'].includes(item?.level) ? item.level : null;
  if (!id || !productId || !productIds.has(productId) || !code || !level) { stats.skippedInvalid++; return null; }
  return { sql: `INSERT INTO serialized_objects(id,tenant_id,product_id,code,level,current_organization_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,code) DO NOTHING`, params: [id, tenantId, productId, code, level, organizationId] };
}

function eventPlan(item, tenantId, objectIds, organizationId, stats) {
  stats.eventsSeen++;
  const id = asUuid(item?.id) || randomUUID(), objectId = asUuid(item?.objectId), eventType = text(item?.eventType || item?.type, 80), actorId = text(item?.actorId, 160), actorRole = text(item?.actorRole, 80), eventTime = text(item?.eventTime, 80), readPoint = text(item?.readPoint, 240), key = text(item?.idempotencyKey || item?.id, 240);
  if (!objectId || !objectIds.has(objectId) || !eventType || !actorId || !actorRole || !eventTime || !readPoint || !key) { stats.skippedInvalid++; return null; }
  return { sql: `INSERT INTO trace_events(id,tenant_id,event_type,object_id,actor_id,actor_role,organization_id,event_time,read_point,verification_status,idempotency_key,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'VERIFIED',$10,$11) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`, params: [id, tenantId, eventType, objectId, actorId, actorRole, organizationId, eventTime, readPoint, key, (item.metadata && typeof item.metadata === 'object') ? item.metadata : {}] };
}

export function buildNormalizationPlan({ localOrganization, workspace, mapping }) {
  const stats = { productsSeen: 0, productsWritten: 0, objectsSeen: 0, objectsWritten: 0, eventsSeen: 0, eventsWritten: 0, skippedInvalid: 0, skippedUnmapped: 0 };
  if (!mapping || mapping.local_tenant_id !== localOrganization.tenant_id || mapping.core_tenant_id !== localOrganization.tenant_id) {
    stats.skippedUnmapped = list(workspace?.products).length + Object.keys(workspace?.objects || {}).length + list(workspace?.events).length;
    return { statements: [], stats };
  }
  const products = list(workspace?.products).map((item) => productPlan(item, mapping.core_tenant_id, stats)).filter(Boolean);
  const productIds = new Set(products.map((plan) => plan.params[0]));
  const objectSource = workspace?.objects && typeof workspace.objects === 'object' && !Array.isArray(workspace.objects) ? workspace.objects : {};
  const objects = Object.values(objectSource).map((item) => objectPlan(item, mapping.core_tenant_id, productIds, mapping.core_organization_id, stats)).filter(Boolean);
  const objectIds = new Set(objects.map((plan) => plan.params[0]));
  const events = list(workspace?.events).map((item) => eventPlan(item, mapping.core_tenant_id, objectIds, mapping.core_organization_id, stats)).filter(Boolean);
  stats.productsWritten = products.length; stats.objectsWritten = objects.length; stats.eventsWritten = events.length;
  return { statements: [...products, ...objects, ...events], stats };
}
