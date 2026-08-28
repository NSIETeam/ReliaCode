import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

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
  assert.throws(() => loadConfig({ NODE_ENV:"production", DATABASE_URL:"postgres://db", AUTH_MODE:"local", ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", SESSION_COOKIE_SECURE:"false" }), /ALLOW_INSECURE_HTTP/);
});

test("production local auth accepts explicitly enabled IP HTTP bootstrap", () => {
  const config=loadConfig({ NODE_ENV:"production", DATABASE_URL:"postgres://db", AUTH_MODE:"local", ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", SESSION_COOKIE_SECURE:"false", ALLOW_INSECURE_HTTP:"true", PUBLIC_ORIGINS:"http://8.140.52.117" });
  assert.equal(config.SESSION_COOKIE_SECURE, false);
  assert.deepEqual(config.corsOrigins, ["http://localhost:4173", "http://8.140.52.117"]);
});

test("production disables direct tenant registration by default", () => {
  const config=loadConfig({NODE_ENV:"production",DATABASE_URL:"postgres://db",AUTH_MODE:"local",ADMIN_PASSWORD_HASH:"scrypt$16384$8$1$00112233445566778899aabbccddeeff$00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"});
  assert.equal(config.ALLOW_PUBLIC_REGISTRATION,false);
  assert.equal(config.ENABLE_LEGACY_SYNC_CODE_GENERATION,false);
});

test("webhook encryption key must decode to exactly 32 bytes", () => {
  assert.throws(() => loadConfig({ DATABASE_URL:"postgres://db", AUTH_MODE:"development", WEBHOOK_ENCRYPTION_KEY:"x".repeat(44) }), /32-byte key/);
  const config=loadConfig({ DATABASE_URL:"postgres://db", AUTH_MODE:"development", WEBHOOK_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64url") });
  assert.equal(Buffer.from(config.WEBHOOK_ENCRYPTION_KEY,"base64url").length,32);
});
