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
  ALLOW_PUBLIC_REGISTRATION: boolean.optional(),
  ENABLE_LEGACY_SYNC_CODE_GENERATION: boolean.optional(),
  REQUIRE_DEVICE_AUTHORIZATION: boolean.optional(),
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
  SESSION_ROTATION_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),
  PASSKEY_STEP_UP_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  SESSION_FINGERPRINT_KEY: z.string().min(43).optional(),
  SMTP_URL: z.string().min(1).optional(),
  SMTP_URL_FILE: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).max(254).refine(value=>!/[\r\n]/.test(value)).optional(),
  ACCOUNT_RECOVERY_BASE_URL: z.string().url().optional(),
  TRUST_PROXY: boolean.default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  OPEN_EPCIS_BASE_URL: z.string().url().optional(),
  OPEN_EPCIS_BEARER_TOKEN: z.string().min(20).optional(),
  OPEN_EPCIS_BEARER_TOKEN_FILE: z.string().min(1).optional(),
  GS1_DIGITAL_LINK_BASE_URL: z.string().url().optional(),
  WEBAUTHN_RP_NAME: z.string().min(1).max(100).default("ReliaCode"),
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_ORIGIN: z.string().url().optional(),
  METRICS_BEARER_TOKEN: z.string().min(32).optional(),
  WEBHOOK_ENCRYPTION_KEY: z.string().min(43).optional(),
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_REGION: z.string().min(1).default("auto"),
  OBJECT_STORAGE_BUCKET: z.string().min(3).max(63).optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID_FILE: z.string().min(1).optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY_FILE: z.string().min(1).optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: boolean.default(false),
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
  if (config.WEBHOOK_ENCRYPTION_KEY) {
    const webhookKey=Buffer.from(config.WEBHOOK_ENCRYPTION_KEY, "base64url");
    if (webhookKey.length !== 32 || webhookKey.toString("base64url") !== config.WEBHOOK_ENCRYPTION_KEY) throw new Error("WEBHOOK_ENCRYPTION_KEY must be a canonical base64url-encoded 32-byte key");
  }
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
  if(config.SESSION_FINGERPRINT_KEY){const fingerprintKey=Buffer.from(config.SESSION_FINGERPRINT_KEY,"base64url");if(fingerprintKey.length!==32||fingerprintKey.toString("base64url")!==config.SESSION_FINGERPRINT_KEY)throw new Error("SESSION_FINGERPRINT_KEY must be a canonical base64url-encoded 32-byte key");}
  if(config.NODE_ENV==="production"&&config.AUTH_MODE==="local"&&!config.SESSION_FINGERPRINT_KEY)throw new Error("SESSION_FINGERPRINT_KEY is required when AUTH_MODE=local in production");
  if (config.AUTH_MODE === "oidc" && !config.OIDC_ISSUER_URL) {
    throw new Error("OIDC_ISSUER_URL is required when AUTH_MODE=oidc");
  }
  const objectStorageAccessKeyId=config.OBJECT_STORAGE_ACCESS_KEY_ID||(config.OBJECT_STORAGE_ACCESS_KEY_ID_FILE?readFileSync(config.OBJECT_STORAGE_ACCESS_KEY_ID_FILE,"utf8").trim():"");
  const objectStorageSecretAccessKey=config.OBJECT_STORAGE_SECRET_ACCESS_KEY||(config.OBJECT_STORAGE_SECRET_ACCESS_KEY_FILE?readFileSync(config.OBJECT_STORAGE_SECRET_ACCESS_KEY_FILE,"utf8").trim():"");
  const objectStorageValues=[config.OBJECT_STORAGE_ENDPOINT,config.OBJECT_STORAGE_BUCKET,objectStorageAccessKeyId,objectStorageSecretAccessKey];
  if(objectStorageValues.some(Boolean)&&!objectStorageValues.every(Boolean))throw new Error("Object storage endpoint, bucket, access key, and secret key must be configured together");
  const smtpUrl=config.SMTP_URL||(config.SMTP_URL_FILE?readFileSync(config.SMTP_URL_FILE,"utf8").trim():"");
  const emailValues=[smtpUrl,config.EMAIL_FROM,config.ACCOUNT_RECOVERY_BASE_URL];if(emailValues.some(Boolean)&&!emailValues.every(Boolean))throw new Error("SMTP URL, email sender, and account recovery URL must be configured together");
  if(config.NODE_ENV==="production"&&config.AUTH_MODE==="local"&&!emailValues.every(Boolean))throw new Error("Verified email recovery configuration is required when AUTH_MODE=local in production");
  const openEpcisBearerToken=config.OPEN_EPCIS_BEARER_TOKEN||(config.OPEN_EPCIS_BEARER_TOKEN_FILE?readFileSync(config.OPEN_EPCIS_BEARER_TOKEN_FILE,"utf8").trim():"");
  if(config.NODE_ENV==="production"&&config.OPEN_EPCIS_BASE_URL&&!openEpcisBearerToken)throw new Error("OPEN_EPCIS_BEARER_TOKEN or OPEN_EPCIS_BEARER_TOKEN_FILE is required in production");
  return {
    ...config,
    ALLOW_PUBLIC_REGISTRATION: config.ALLOW_PUBLIC_REGISTRATION ?? config.NODE_ENV !== "production",
    ENABLE_LEGACY_SYNC_CODE_GENERATION: config.ENABLE_LEGACY_SYNC_CODE_GENERATION ?? config.NODE_ENV !== "production",
    REQUIRE_DEVICE_AUTHORIZATION: config.REQUIRE_DEVICE_AUTHORIZATION ?? config.NODE_ENV === "production",
    DATABASE_URL: databaseUrl,
    OBJECT_STORAGE_ACCESS_KEY_ID:objectStorageAccessKeyId||undefined,
    OBJECT_STORAGE_SECRET_ACCESS_KEY:objectStorageSecretAccessKey||undefined,
    objectStorageConfigured:objectStorageValues.every(Boolean),
    SMTP_URL:smtpUrl||undefined,
    OPEN_EPCIS_BEARER_TOKEN:openEpcisBearerToken||undefined,
    emailDeliveryConfigured:emailValues.every(Boolean),
    corsOrigins: [...new Set((config.CORS_ORIGINS + "," + (config.PUBLIC_ORIGINS || "")).split(",").map((value) => value.trim()).filter(Boolean))]
  };
}
