import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../apps/scan-api/tests/production-scale-gates.mjs', import.meta.url), 'utf8');

test('million-code gate includes generated rows, export integrity and HTTPS download', () => {
  assert.match(source, /generated_count\)!==1_000_000/);
  assert.match(source, /export_status==="COMPLETED"/);
  assert.match(source, /output_size_bytes/);
  assert.match(source, /output_sha256/);
  assert.match(source, /million-code HTTPS presigned download is unavailable/);
});

test('every scale gate fails closed unless readiness identifies a performance environment', () => {
  assert.match(source, /await requirePerformanceEnvironment\(\)/);
  assert.match(source, /deploymentEnvironment!=="performance"/);
  assert.match(source, /DEPLOYMENT_ENVIRONMENT=performance/);
});

test('ten-million gate refuses elevated or write-capable database roles', () => {
  for (const check of ['rolsuper','rolbypassrls','rolcreatedb','rolcreaterole','schema_create','table_write']) assert.match(source, new RegExp(check));
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /PERF_DATABASE_URL must use a non-elevated read-only role/);
});
