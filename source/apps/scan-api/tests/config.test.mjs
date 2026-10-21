import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const fingerprintKey=Buffer.alloc(32,9).toString("base64url");
const emailRecovery={SMTP_URL:"smtps://user:password@smtp.example.cn:465",EMAIL_FROM:"ReliaCode <no-reply@example.cn>",ACCOUNT_RECOVERY_BASE_URL:"https://reliacode.example/"};
const releaseSha="0123456789abcdef0123456789abcdef01234567";
const fixture=(name)=>fileURLToPath(new URL(`./fixtures/${name}`,import.meta.url));
const formalProduction={DEPLOYMENT_ENVIRONMENT:"production",DATABASE_SSL:"true",SYSTEM_DATABASE_URL:"postgres://reliacode_system@db/reliacode",TENANT_DATABASE_ROLE:"reliacode_tenant",SYSTEM_DATABASE_ROLE:"reliacode_system",TRUST_PROXY:"true",CORS_ORIGINS:"https://reliacode.example",PUBLIC_ORIGINS:"https://reliacode.example",WEBAUTHN_ORIGIN:"https://reliacode.example",SESSION_COOKIE_NAME:"__Host-reliacode_session",CSRF_COOKIE_NAME:"__Host-reliacode_csrf",SESSION_FINGERPRINT_KEY_FILE:fixture("session-fingerprint-key.txt"),METRICS_BEARER_TOKEN_FILE:fixture("metrics-bearer-token.txt"),WEBHOOK_ENCRYPTION_KEY_FILE:fixture("webhook-encryption-key.txt"),OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:"https://otel.example/v1/traces",OTEL_EXPORTER_OTLP_HEADERS_FILE:fixture("otel-headers.txt"),GIT_SHA:releaseSha,APP_VERSION:`sha-${releaseSha}`};

test("production rejects development authentication", () => {
  assert.throws(() => loadConfig({ NODE_ENV:"production", DATABASE_URL:"postgres://db", AUTH_MODE:"development" }), /AUTH_MODE must be oidc/);
});

test("oidc requires issuer", () => {
  assert.throws(() => loadConfig({ DATABASE_URL:"postgres://db", AUTH_MODE:"oidc" }), /OIDC_ISSUER_URL/);
});

test("development configuration is explicit", () => {
  const config = loadConfig({ DATABASE_URL:"postgres://db", AUTH_MODE:"development", CORS_ORIGINS:"http://localhost:4173" });
  assert.equal(config.AUTH_MODE, "development");
  assert.deepEqual(config.corsOrigins, ["http://localhost:4173"]);
});

test("production local auth rejects insecure cookies without explicit opt-in", () => {
  assert.throws(() => loadConfig({ NODE_ENV:"production", DATABASE_URL:"postgres://db", AUTH_MODE:"local", ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", SESSION_COOKIE_SECURE:"false",SESSION_FINGERPRINT_KEY:fingerprintKey }), /ALLOW_INSECURE_HTTP/);
});

test("production local auth accepts explicitly enabled IP HTTP bootstrap", () => {
  const config=loadConfig({ NODE_ENV:"production", DATABASE_URL:"postgres://db", AUTH_MODE:"local", ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", SESSION_COOKIE_SECURE:"false", ALLOW_INSECURE_HTTP:"true", PUBLIC_ORIGINS:"http://8.140.52.117",SESSION_FINGERPRINT_KEY:fingerprintKey,...emailRecovery });
  assert.equal(config.SESSION_COOKIE_SECURE, false);
  assert.deepEqual(config.corsOrigins, ["http://localhost:4173", "http://8.140.52.117"]);
});

test("production disables direct tenant registration by default", () => {
  const config=loadConfig({NODE_ENV:"production",DATABASE_URL:"postgres://db",AUTH_MODE:"local",ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",SESSION_FINGERPRINT_KEY:fingerprintKey,...emailRecovery});
  assert.equal(config.ALLOW_PUBLIC_REGISTRATION,false);
  assert.equal(config.ENABLE_LEGACY_SYNC_CODE_GENERATION,false);
  assert.equal(config.REQUIRE_DEVICE_AUTHORIZATION,true);
});

test("production uses real platform users and forbids the legacy shared administrator",()=>{
  const config=loadConfig({NODE_ENV:"production",...formalProduction,DATABASE_URL:"postgres://reliacode_tenant@db/reliacode",AUTH_MODE:"local",...emailRecovery});
  assert.equal(config.ENABLE_LEGACY_BOOTSTRAP_ADMIN,false);
  assert.equal(config.ADMIN_PASSWORD_HASH,undefined);
  assert.throws(()=>loadConfig({NODE_ENV:"production",DEPLOYMENT_ENVIRONMENT:"production",DATABASE_URL:"postgres://db",AUTH_MODE:"local",ENABLE_LEGACY_BOOTSTRAP_ADMIN:"true",ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",SESSION_FINGERPRINT_KEY:fingerprintKey,...emailRecovery}),/forbidden/);
});

test("formal production rejects plaintext database and service transports",()=>{
  const base={NODE_ENV:"production",...formalProduction,DATABASE_URL:"postgres://reliacode_tenant@db/reliacode",AUTH_MODE:"local",...emailRecovery};
  assert.throws(()=>loadConfig({...base,DATABASE_SSL:"false"}),/DATABASE_SSL=true/);
  assert.throws(()=>loadConfig({...base,SYSTEM_DATABASE_URL:undefined}),/distinct tenant and trusted system database connections/);
  assert.throws(()=>loadConfig({...base,SYSTEM_DATABASE_URL:"postgres://wrong_role@db/reliacode"}),/usernames must match/);
  assert.throws(()=>loadConfig({...base,SESSION_COOKIE_NAME:"reliacode_session"}),/__Host-/);
  assert.throws(()=>loadConfig({...base,GIT_SHA:"unknown",APP_VERSION:"development"}),/full immutable GIT_SHA/);
  assert.throws(()=>loadConfig({...base,SESSION_FINGERPRINT_KEY_FILE:undefined,SESSION_FINGERPRINT_KEY:fingerprintKey}),/requires session fingerprint, metrics, and webhook keys to use secret files/);
  assert.throws(()=>loadConfig({...base,OTEL_EXPORTER_OTLP_HEADERS_FILE:undefined,OTEL_EXPORTER_OTLP_HEADERS:"authorization=Bearer%20inline"}),/file-backed headers/);
  assert.throws(()=>loadConfig({...base,CORS_ORIGINS:"http://reliacode.example"}),/exact HTTPS origin/);
  assert.throws(()=>loadConfig({...base,CORS_ORIGINS:"https://reliacode.example/login"}),/exact HTTPS origin/);
  assert.throws(()=>loadConfig({...base,OPEN_EPCIS_BASE_URL:"http://epcis.example",OPEN_EPCIS_BEARER_TOKEN:"long-production-bearer-token"}),/OPEN_EPCIS_BASE_URL must use HTTPS/);
  assert.throws(()=>loadConfig({...base,OBJECT_STORAGE_ENDPOINT:"http://s3.example",OBJECT_STORAGE_BUCKET:"exports",OBJECT_STORAGE_ACCESS_KEY_ID:"access",OBJECT_STORAGE_SECRET_ACCESS_KEY:"secret"}),/OBJECT_STORAGE_ENDPOINT must use HTTPS/);
  assert.throws(()=>loadConfig({...base,SMTP_URL:"smtp://user:password@smtp.example:587"}),/SMTP_URL must use SMTPS/);
});

test("a controlled pilot can explicitly enable the legacy bootstrap account",()=>{
  const config=loadConfig({NODE_ENV:"production",DEPLOYMENT_ENVIRONMENT:"pilot",DATABASE_URL:"postgres://db",AUTH_MODE:"local",ENABLE_LEGACY_BOOTSTRAP_ADMIN:"true",ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",SESSION_FINGERPRINT_KEY:fingerprintKey,...emailRecovery});
  assert.equal(config.ENABLE_LEGACY_BOOTSTRAP_ADMIN,true);
});

test("webhook encryption key must decode to exactly 32 bytes", () => {
  assert.throws(() => loadConfig({ DATABASE_URL:"postgres://db", AUTH_MODE:"development", WEBHOOK_ENCRYPTION_KEY:"x".repeat(44) }), /32-byte key/);
  const config=loadConfig({ DATABASE_URL:"postgres://db", AUTH_MODE:"development", WEBHOOK_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64url") });
  assert.equal(Buffer.from(config.WEBHOOK_ENCRYPTION_KEY,"base64url").length,32);
});

test("file-backed secrets are single-line and reject ambiguous direct overrides",()=>{
  const config=loadConfig({DATABASE_URL:"postgres://db",AUTH_MODE:"development",SESSION_FINGERPRINT_KEY_FILE:fixture("session-fingerprint-key.txt"),METRICS_BEARER_TOKEN_FILE:fixture("metrics-bearer-token.txt"),WEBHOOK_ENCRYPTION_KEY_FILE:fixture("webhook-encryption-key.txt")});
  assert.equal(config.SESSION_FINGERPRINT_KEY,fingerprintKey);
  assert.equal(config.METRICS_BEARER_TOKEN,"test-only-metrics-bearer-token-000000000000");
  assert.equal(Buffer.from(config.WEBHOOK_ENCRYPTION_KEY,"base64url").length,32);
  assert.throws(()=>loadConfig({DATABASE_URL:"postgres://db",AUTH_MODE:"development",SESSION_FINGERPRINT_KEY:fingerprintKey,SESSION_FINGERPRINT_KEY_FILE:fixture("session-fingerprint-key.txt")}),/cannot both be configured/);
});

test("object storage configuration is all-or-nothing",()=>{assert.throws(()=>loadConfig({DATABASE_URL:"postgres://db",AUTH_MODE:"development",OBJECT_STORAGE_ENDPOINT:"https://s3.example.cn"}),/configured together/);const config=loadConfig({DATABASE_URL:"postgres://db",AUTH_MODE:"development",OBJECT_STORAGE_ENDPOINT:"https://s3.example.cn",OBJECT_STORAGE_BUCKET:"exports",OBJECT_STORAGE_ACCESS_KEY_ID:"access",OBJECT_STORAGE_SECRET_ACCESS_KEY:"secret"});assert.equal(config.objectStorageConfigured,true);});

test("verified email recovery configuration is all-or-nothing",()=>{assert.throws(()=>loadConfig({DATABASE_URL:"postgres://db",AUTH_MODE:"development",SMTP_URL:"smtps://smtp.example.cn"}),/configured together/);const config=loadConfig({DATABASE_URL:"postgres://db",AUTH_MODE:"development",...emailRecovery});assert.equal(config.emailDeliveryConfigured,true);});

test("production OpenEPCIS requires a bearer credential",()=>{assert.throws(()=>loadConfig({NODE_ENV:"production",DATABASE_URL:"postgres://db",AUTH_MODE:"oidc",OIDC_ISSUER_URL:"https://identity.example.cn",OPEN_EPCIS_BASE_URL:"https://epcis.example.cn"}),/OPEN_EPCIS_BEARER_TOKEN/);const config=loadConfig({NODE_ENV:"production",DATABASE_URL:"postgres://db",AUTH_MODE:"oidc",OIDC_ISSUER_URL:"https://identity.example.cn",OPEN_EPCIS_BASE_URL:"https://epcis.example.cn",OPEN_EPCIS_BEARER_TOKEN:"contract-bearer-token-secret"});assert.equal(config.OPEN_EPCIS_BEARER_TOKEN,"contract-bearer-token-secret");});

test("production local authentication requires a keyed session fingerprint",()=>{assert.throws(()=>loadConfig({NODE_ENV:"production",DATABASE_URL:"postgres://db",AUTH_MODE:"local",ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"}),/SESSION_FINGERPRINT_KEY/);assert.throws(()=>loadConfig({DATABASE_URL:"postgres://db",AUTH_MODE:"development",SESSION_FINGERPRINT_KEY:"x".repeat(44)}),/32-byte key/);});
