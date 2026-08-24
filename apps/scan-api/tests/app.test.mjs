import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";

const config = loadConfig({
  NODE_ENV:"test",
  DATABASE_URL:"postgres://unused",
  AUTH_MODE:"development",
  CORS_ORIGINS:"http://localhost:4173",
  LOG_LEVEL:"silent"
});
const db = { query: async (sql) => ({ rowCount:1, rows:[sql.includes("SELECT EXISTS") ? { active:true } : { "?column?":1 }] }) };

test("health endpoints do not require authentication", async (t) => {
  const app = await buildApp({ config, db });
  t.after(() => app.close());
  const live = await app.inject({ method:"GET", url:"/health/live" });
  const ready = await app.inject({ method:"GET", url:"/health/ready" });
  assert.equal(live.statusCode, 200);
  assert.equal(ready.statusCode, 200);
});

test("business routes reject anonymous requests", async (t) => {
  const app = await buildApp({ config, db });
  t.after(() => app.close());
  const response = await app.inject({ method:"GET", url:"/api/v1/me" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "UNAUTHORIZED");
});

test("development principal is normalized and authorized", async (t) => {
  const app = await buildApp({ config, db });
  t.after(() => app.close());
  const principal = JSON.stringify({
    sub:"user-1", tenant_id:"tenant-1", organization_id:"org-1", role:"BRAND_ADMIN", name:"林岚"
  });
  const response = await app.inject({ method:"GET", url:"/api/v1/me", headers:{ "x-reliacode-principal":principal } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().role, "BRAND_ADMIN");
  assert.ok(response.json().capabilities.includes("codes:write"));
});

test("token claims cannot escape the active database scope", async (t) => {
  const inactiveDb = { query:async () => ({ rowCount:1, rows:[{ active:false }] }) };
  const app = await buildApp({ config, db:inactiveDb });
  t.after(() => app.close());
  const principal = JSON.stringify({ sub:"user-2",tenant_id:"unknown",organization_id:"unknown",role:"BRAND_ADMIN" });
  const response = await app.inject({ method:"GET",url:"/api/v1/me",headers:{ "x-reliacode-principal":principal } });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "PRINCIPAL_SCOPE_INACTIVE");
});
