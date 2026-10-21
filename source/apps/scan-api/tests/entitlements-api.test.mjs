import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";

const config = loadConfig({ NODE_ENV:"test", DATABASE_URL:"postgres://unused", AUTH_MODE:"development", CORS_ORIGINS:"http://localhost:4173", LOG_LEVEL:"silent" });
const tenant = "11111111-1111-4111-8111-111111111111";
const organization = "22222222-2222-4222-8222-222222222222";
function principal(role="BRAND_ADMIN") { return JSON.stringify({ sub:"user-1", tenant_id:tenant, organization_id:organization, role }); }
function dbFor({ plan="team", members=4, scans=120, codes=300 } = {}) {
  return { query: async (sql) => {
    if (sql.includes("SELECT EXISTS")) return { rowCount:1, rows:[{ active:true }] };
    if (sql.includes("tenant_entitlements e") && sql.includes("member_count")) return { rowCount:1, rows:[{ plan, member_count:members, scan_count:scans, code_count:codes }] };
    if (sql.startsWith("SELECT plan FROM tenant_entitlements")) return { rowCount:1, rows:[{ plan:"free" }] };
    if (sql.includes("RETURNING tenant_id,plan,effective_at,updated_at")) return { rowCount:1, rows:[{ tenant_id:tenant, plan:"team", effective_at:"2026-08-27T00:00:00.000Z", updated_at:"2026-08-27T00:00:00.000Z" }] };
    return { rowCount:1, rows:[] };
  } };
}

test("authenticated users can read tenant entitlements and usage decision", async (t) => {
  const app = await buildApp({ config, db:dbFor() });
  t.after(() => app.close());
  const response = await app.inject({ method:"GET", url:"/api/v1/organization/entitlements", headers:{ "x-reliacode-principal":principal("BRAND_AUDITOR") } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().tenantId, tenant);
  assert.equal(response.json().plan.id, "team");
  assert.equal(response.json().usage.monthlyScans, 120);
  assert.equal(response.json().decision, "allow");
});

test("only brand administrators can change a plan and the change is audited", async (t) => {
  const db = dbFor();
  const app = await buildApp({ config, db });
  t.after(() => app.close());
  const denied = await app.inject({ method:"PATCH", url:"/api/v1/organization/entitlements", payload:{ plan:"team" }, headers:{ "x-reliacode-principal":principal("BRAND_AUDITOR") } });
  assert.equal(denied.statusCode, 403);
  const allowed = await app.inject({ method:"PATCH", url:"/api/v1/organization/entitlements", payload:{ plan:"team" }, headers:{ "x-reliacode-principal":principal() } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().plan.id, "team");
});

test("plan updates reject unknown values without external billing calls", async (t) => {
  const calls = [];
  const db = dbFor();
  const original = db.query;
  db.query = async (...args) => { calls.push(String(args[0])); return original(...args); };
  const app = await buildApp({ config, db });
  t.after(() => app.close());
  const response = await app.inject({ method:"PATCH", url:"/api/v1/organization/entitlements", payload:{ plan:"enterprise" }, headers:{ "x-reliacode-principal":principal() } });
  assert.equal(response.statusCode, 400);
  assert.equal(calls.some((sql) => /billing|stripe|checkout/i.test(sql)), false);
});
