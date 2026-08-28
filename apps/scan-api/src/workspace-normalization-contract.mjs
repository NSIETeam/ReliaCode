import { createHash } from "node:crypto";
import { isValidGtin } from "./gs1.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = ["preferences", "products", "codeBatches", "objects", "traceEvents", "operationEvents", "campaigns", "ledger", "risks", "agentRuns", "rejects"];
const asObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const asArray = (value) => Array.isArray(value) ? value : [];
const uuid = (value) => typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
const string = (value, max = 512) => typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
const first = (item, ...keys) => keys.map((key) => item?.[key]).find((value) => value !== undefined && value !== null);
const contextUuid = (value, name) => {
  const result = uuid(value);
  if (!result) throw new TypeError(`${name} must be a UUID`);
  return result;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function semanticHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function sourceItems(workspace, ...keys) {
  for (const key of keys) {
    const value = workspace?.[key];
    if (Array.isArray(value)) return value.map((item, index) => ({ item, index, key }));
    if (asObject(value)) return Object.entries(value).map(([entryKey, item], index) => ({ item: { ...(asObject(item) || {}), _legacyKey: entryKey }, index, key }));
  }
  return [];
}

function safeRecord(category, item, index, ctx, fields = {}) {
  const record = { ...fields, sourceIndex: index, category, tenantId: ctx.tenantId, organizationId: ctx.organizationId };
  const id = uuid(first(item, "id", "uuid", "publicId"));
  if (id) record.id = id;
  const hashInput = { ...record };
  delete hashInput.sourceIndex;
  record.semanticHash = semanticHash(hashInput);
  return record;
}

function reject(out, category, index, reason, item) {
  out.rejects.push({ category, sourceIndex: index, reason, sourceHash: semanticHash({ category, index, keys: asObject(item) ? Object.keys(item).sort() : typeof item }) });
}

function validContext(item, ctx) {
  const tenant = first(item, "tenantId", "tenant_id", "租户Id", "租户ID");
  const org = first(item, "organizationId", "organization_id", "orgId", "组织Id", "组织ID");
  return (!tenant || uuid(tenant) === ctx.tenantId) && (!org || uuid(org) === ctx.organizationId);
}

function normalizePreferences(workspace, out, ctx) {
  const raw = first(workspace, "preferences", "settings", "config", "偏好设置", "设置");
  if (raw === undefined) return;
  const value = asObject(raw);
  if (!value) return reject(out, "preferences", 0, "PREFERENCES_NOT_OBJECT", raw);
  out.preferences.push(safeRecord("preferences", value, 0, ctx, { value: canonical(value) }));
}

export function normalizeWorkspace(workspace, context) {
  const ctx = { tenantId: contextUuid(context?.tenantId, "tenantId"), organizationId: contextUuid(context?.organizationId, "organizationId") };
  const out = Object.fromEntries(CATEGORIES.map((category) => [category, []]));
  if (!asObject(workspace)) {
    reject(out, "workspace", 0, "WORKSPACE_NOT_OBJECT", workspace);
    return finalize(out);
  }
  normalizePreferences(workspace, out, ctx);

  const products = new Set();
  for (const { item, index } of sourceItems(workspace, "products", "产品", "productCatalog")) {
    if (!validContext(item, ctx)) { reject(out, "products", index, "TENANT_OR_ORGANIZATION_MISMATCH", item); continue; }
    const id = uuid(first(item, "id", "uuid"));
    const sku = string(first(item, "sku", "SKU", "code", "编码"), 160);
    const name = string(first(item, "name", "productName", "产品名", "名称"), 240);
    if (!id || !sku || !name) { reject(out, "products", index, "PRODUCT_ID_SKU_NAME_REQUIRED", item); continue; }
    const gtin = string(first(item, "gtin", "GTIN"), 80);
    if (gtin && !isValidGtin(gtin)) { reject(out, "products", index, "PRODUCT_GTIN_INVALID", item); continue; }
    products.add(id);
    out.products.push(safeRecord("products", item, index, ctx, { id, sku, name, gtin, status: string(first(item, "status", "状态"), 32) || "ACTIVE" }));
  }

  const batches = new Set();
  for (const { item, index } of sourceItems(workspace, "codeBatches", "code_batches", "batches", "生码批次")) {
    if (!validContext(item, ctx)) { reject(out, "codeBatches", index, "TENANT_OR_ORGANIZATION_MISMATCH", item); continue; }
    const id = uuid(first(item, "id", "uuid"));
    const productId = uuid(first(item, "productId", "product_id", "产品Id", "产品ID"));
    const level = string(first(item, "level", "层级"), 16);
    const quantity = Number(first(item, "quantity", "数量"));
    if (!id || !productId || !products.has(productId) || !["ITEM", "CASE", "PALLET"].includes(level) || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000000) { reject(out, "codeBatches", index, "BATCH_REFERENCE_OR_SHAPE_INVALID", item); continue; }
    batches.add(id);
    out.codeBatches.push(safeRecord("codeBatches", item, index, ctx, { id, productId, level, quantity, status: string(first(item, "status", "状态"), 32) || "GENERATED" }));
  }

  const objects = new Set();
  for (const { item, index } of sourceItems(workspace, "objects", "serializedObjects", "serialized_objects", "对象")) {
    if (!validContext(item, ctx)) { reject(out, "objects", index, "TENANT_OR_ORGANIZATION_MISMATCH", item); continue; }
    const id = uuid(first(item, "id", "uuid", "publicId"));
    const code = string(first(item, "code", "可靠码", "序列码", "_legacyKey"), 240);
    const productId = uuid(first(item, "productId", "product_id", "产品Id", "产品ID"));
    const batchId = first(item, "codeBatchId", "code_batch_id", "batchId") ? uuid(first(item, "codeBatchId", "code_batch_id", "batchId")) : null;
    const parentId = first(item, "parentId", "parent_id", "父对象") ? uuid(first(item, "parentId", "parent_id", "父对象")) : null;
    const level = string(first(item, "level", "层级"), 16);
    if (!id || !code || !productId || !products.has(productId) || (batchId && !batches.has(batchId)) || (parentId && parentId === id) || !["ITEM", "CASE", "PALLET"].includes(level)) { reject(out, "objects", index, "OBJECT_REFERENCE_OR_SHAPE_INVALID", item); continue; }
    objects.add(id);
    out.objects.push(safeRecord("objects", item, index, ctx, { id, code, productId, codeBatchId: batchId, parentId, level, status: string(first(item, "status", "状态"), 32) || "COMMISSIONED" }));
  }
  const objectIds = new Set(out.objects.map((item) => item.id));
  for (const record of out.objects) if (record.parentId && !objectIds.has(record.parentId)) { reject(out, "objects", record.sourceIndex, "PARENT_REFERENCE_MISSING", record); out.objects = out.objects.filter((candidate) => candidate !== record); }

  const forbiddenTrace = /fail|reject|invalid|error|commission|generate|code|agent|验证失败|拒绝|失败|生码|生成|代理/i;
  for (const { item, index } of sourceItems(workspace, "events", "traceEvents", "trace_events", "事件")) {
    if (!validContext(item, ctx)) { reject(out, "traceEvents", index, "TENANT_OR_ORGANIZATION_MISMATCH", item); continue; }
    const id = uuid(first(item, "id", "uuid"));
    const objectId = uuid(first(item, "objectId", "object_id", "对象Id", "对象ID"));
    const eventType = string(first(item, "eventType", "event_type", "type", "action", "动作"), 80);
    const verification = string(first(item, "verificationStatus", "verification_status", "status", "验证状态"), 32) || "VERIFIED";
    const eventTime = string(first(item, "eventTime", "event_time", "time", "时间"), 80);
    if (!id || !objectId || !objectIds.has(objectId) || !eventType || forbiddenTrace.test(eventType) || verification !== "VERIFIED" || !eventTime) { reject(out, "traceEvents", index, "TRACE_EVENT_NOT_VERIFIED_OR_OBJECT_MISSING", item); continue; }
    out.traceEvents.push(safeRecord("traceEvents", item, index, ctx, { id, objectId, eventType, eventTime, verificationStatus: "VERIFIED", readPoint: string(first(item, "readPoint", "read_point", "读取点"), 240) || "legacy" }));
  }

  for (const { item, index } of sourceItems(workspace, "operations", "operationEvents", "operation_events", "操作事件")) {
    if (!validContext(item, ctx)) { reject(out, "operationEvents", index, "TENANT_OR_ORGANIZATION_MISMATCH", item); continue; }
    const action = string(first(item, "action", "type", "eventType", "动作"), 80);
    const id = uuid(first(item, "id", "uuid"));
    if (!id || !action) { reject(out, "operationEvents", index, "OPERATION_ID_ACTION_REQUIRED", item); continue; }
    out.operationEvents.push(safeRecord("operationEvents", item, index, ctx, { id, action, outcome: string(first(item, "outcome", "result", "结果"), 240) }));
  }

  const simple = [["campaigns", ["campaigns", "campaign", "活动"]], ["ledger", ["ledger", "ledgerEntries", "账本"]], ["risks", ["risks", "riskCases", "风险"]], ["agentRuns", ["agentRuns", "agent_runs", "agentOperations", "代理运行"]]];
  for (const [category, keys] of simple) for (const { item, index } of sourceItems(workspace, ...keys)) {
    if (!validContext(item, ctx)) { reject(out, category, index, "TENANT_OR_ORGANIZATION_MISMATCH", item); continue; }
    const id = uuid(first(item, "id", "uuid"));
    if (!id) { reject(out, category, index, `${category.toUpperCase()}_ID_REQUIRED`, item); continue; }
    out[category].push(safeRecord(category, item, index, ctx, { id, value: canonical(Object.fromEntries(Object.entries(item).filter(([key]) => !["tenantId", "tenant_id", "organizationId", "organization_id"].includes(key)))) }));
  }
  return finalize(out);
}

function finalize(out) {
  for (const category of CATEGORIES) out[category].sort((a, b) => (a.semanticHash || "").localeCompare(b.semanticHash || "") || (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0));
  return out;
}

export { CATEGORIES };
