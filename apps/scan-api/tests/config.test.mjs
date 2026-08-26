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
