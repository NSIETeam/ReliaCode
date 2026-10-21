import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration=readFileSync(new URL("../migrations/031_trusted_system_database_role.sql",import.meta.url),"utf8");
const runner=readFileSync(new URL("../src/migrate.mjs",import.meta.url),"utf8");

test("system RLS access requires the registered login role, not a forgeable GUC alone",()=>{
  assert.match(migration,/SECURITY DEFINER/);
  assert.match(migration,/role_name=session_user::name/);
  assert.match(migration,/current_setting\('reliacode\.system_access',true\)='on'/);
  assert.doesNotMatch(migration,/role_name=current_user::name/);
  assert.match(runner,/REVOKE ALL ON reliacode_system_database_role/);
});

test("control-plane tables without tenant columns are forced to trusted-system RLS",()=>{
  for(const table of ["admin_workspaces","backup_runs","platform_account_recovery_cases","platform_audit_log","platform_idempotency_records","tenant_applications"])assert.match(migration,new RegExp(`'${table}'`));
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/USING \(reliacode_system_access\(\)\) WITH CHECK \(reliacode_system_access\(\)\)/);
});
