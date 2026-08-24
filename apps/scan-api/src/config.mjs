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
  AUTH_MODE: z.enum(["oidc", "development"]).default("oidc"),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).default("reliacode-api"),
  CORS_ORIGINS: z.string().default("http://localhost:4173"),
  TRUST_PROXY: boolean.default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  OPEN_EPCIS_BASE_URL: z.string().url().optional(),
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
  if (config.NODE_ENV === "production" && config.AUTH_MODE !== "oidc") {
    throw new Error("AUTH_MODE must be oidc in production");
  }
  if (config.AUTH_MODE === "oidc" && !config.OIDC_ISSUER_URL) {
    throw new Error("OIDC_ISSUER_URL is required when AUTH_MODE=oidc");
  }
  return {
    ...config,
    DATABASE_URL: databaseUrl,
    corsOrigins: config.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)
  };
}
