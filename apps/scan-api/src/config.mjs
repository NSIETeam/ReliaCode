import { z } from "zod";
import { readFileSync } from "node:fs";

const boolean = z.preprocess((value) => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false" || value === undefined) return false;
  return value;
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4180),
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_FILE: z.string().min(1).optional(),
  DATABASE_SSL: boolean.default(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  AUTH_MODE: z.enum(["oidc", "local", "development"]).default("oidc"),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).default("reliacode-api"),
  CORS_ORIGINS: z.string().default("http://localhost:4173"),
  PUBLIC_ORIGINS: z.string().optional(),
  ADMIN_USERNAME: z.string().min(1).max(80).default("admin"),
  ADMIN_PASSWORD_HASH: z.string().min(20).optional(),
  ADMIN_TENANT_ID: z.string().uuid().default("00000000-0000-0000-0000-000000000001"),
  ADMIN_ORGANIZATION_ID: z.string().uuid().default("00000000-0000-0000-0000-000000000002"),
  SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default("reliacode_session"),
  CSRF_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default("reliacode_csrf"),
  SESSION_COOKIE_SECURE: boolean.default(true),
  ALLOW_INSECURE_HTTP: boolean.default(false),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  TRUST_PROXY: boolean.default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  OPEN_EPCIS_BASE_URL: z.string().url().optional(),
  GS1_DIGITAL_LINK_BASE_URL: z.string().url().optional(),
  WEBAUTHN_RP_NAME: z.string().min(1).max(100).default("ReliaCode"),
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_ORIGIN: z.string().url().optional(),
  APP_VERSION: z.string().min(1).max(100).default("development"),
  GIT_SHA: z.string().min(1).max(100).default("unknown")
});

export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  const config = result.data;
  const databaseUrl = config.DATABASE_URL || (config.DATABASE_URL_FILE ? readFileSync(config.DATABASE_URL_FILE, "utf8").trim() : "");
  if (!databaseUrl) throw new Error("DATABASE_URL or DATABASE_URL_FILE is required");
  if (config.NODE_ENV === "production" && !["oidc", "local"].includes(config.AUTH_MODE)) {
    throw new Error("AUTH_MODE must be oidc or local in production");
  }
  if (config.NODE_ENV === "production" && config.AUTH_MODE === "local" && !config.ADMIN_PASSWORD_HASH) {
    throw new Error("ADMIN_PASSWORD_HASH is required when AUTH_MODE=local");
  }
  if (config.NODE_ENV === "production" && config.AUTH_MODE === "local" && !config.SESSION_COOKIE_SECURE && !config.ALLOW_INSECURE_HTTP) {
    throw new Error("SESSION_COOKIE_SECURE=false requires ALLOW_INSECURE_HTTP=true in production");
  }
  if (config.AUTH_MODE === "oidc" && !config.OIDC_ISSUER_URL) {
    throw new Error("OIDC_ISSUER_URL is required when AUTH_MODE=oidc");
  }
  return {
    ...config,
    DATABASE_URL: databaseUrl,
    corsOrigins: [...new Set((config.CORS_ORIGINS + "," + (config.PUBLIC_ORIGINS || "")).split(",").map((value) => value.trim()).filter(Boolean))]
  };
}
