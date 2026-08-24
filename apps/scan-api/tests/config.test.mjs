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
