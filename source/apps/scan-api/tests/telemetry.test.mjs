import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { telemetryConfig } from '../src/telemetry.mjs';

test('telemetry is inert when no OTLP collector is configured', () => {
  assert.deepEqual(telemetryConfig({ NODE_ENV:'production' }), { enabled:false, serviceName:'reliacode-api' });
});

test('production tracing requires an HTTPS collector', () => {
  assert.throws(() => telemetryConfig({ NODE_ENV:'production', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'http://collector:4318/v1/traces' }), /must use HTTPS/);
  assert.deepEqual(telemetryConfig({ NODE_ENV:'production', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'https://otel.example/v1/traces', OTEL_SERVICE_NAME:'reliacode-production',OTEL_EXPORTER_OTLP_HEADERS:'authorization=Bearer%20test-token' }), {
    enabled:true,
    endpoint:'https://otel.example/v1/traces',
    serviceName:'reliacode-production',
    headers:{authorization:'Bearer test-token'}
  });
});

test('telemetry reads headers from one protected file and rejects ambiguity',()=>{
  const file=new URL('./fixtures/otel-headers.txt',import.meta.url);
  assert.deepEqual(telemetryConfig({NODE_ENV:'production',OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'https://otel.example/v1/traces',OTEL_EXPORTER_OTLP_HEADERS_FILE:fileURLToPath(file)}).headers,{authorization:'Bearer test-only-otel-token'});
  assert.throws(()=>telemetryConfig({NODE_ENV:'production',OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'https://otel.example/v1/traces',OTEL_EXPORTER_OTLP_HEADERS:'a=b',OTEL_EXPORTER_OTLP_HEADERS_FILE:fileURLToPath(file)}),/cannot both/);
});
