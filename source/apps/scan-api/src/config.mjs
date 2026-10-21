import { z } from "zod";
import { readFileSync } from "node:fs";

const boolean = z.preprocess((value) => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false" || value === undefined) return false;
  return value;
}, z.boolean());

function secretValue(direct,file,label) {
  if(direct&&file)throw new Error(`${label} and ${label}_FILE cannot both be configured`);
  if(!file)return direct||"";
  let value=readFileSync(file,"utf8");
  if(value.endsWith("\n"))value=value.slice(0,-1);
  if(!value||/[\r\n]/.test(value))throw new Error(`${label}_FILE must contain exactly one non-empty line`);
  return value;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEPLOYMENT_ENVIRONMENT: z.enum(["development", "test", "pilot", "production", "performance"]).optional(),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4180),
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_FILE: z.string().min(1).optional(),
  SYSTEM_DATABASE_URL: z.string().min(1).optional(),
  SYSTEM_DATABASE_URL_FILE: z.string().min(1).optional(),
  TENANT_DATABASE_ROLE: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/).optional(),
  SYSTEM_DATABASE_ROLE: z.string().regex(/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/).optional(),
  DATABASE_SSL: boolean.default(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  AUTH_MODE: z.enum(["oidc", "local", "development"]).default("oidc"),
  ENABLE_LEGACY_BOOTSTRAP_ADMIN: boolean.default(false),
  ALLOW_PUBLIC_REGISTRATION: boolean.optional(),
  ENABLE_LEGACY_SYNC_CODE_GENERATION: boolean.optional(),
  REQUIRE_DEVICE_AUTHORIZATION: boolean.optional(),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).default("reliacode-api"),
  CORS_ORIGINS: z.string().default("http://localhost:4173"),
  PUBLIC_ORIGINS: z.string().optional(),
  ADMIN_USERNAME: z.string().min(1).max(80).default("admin"),
  ADMIN_PASSWORD_HASH: z.string().min(20).optional(),
  ADMIN_TENANT_ID: z.string().uuid().default("019d0000-0000-7000-8000-000000000001"),
  ADMIN_ORGANIZATION_ID: z.string().uuid().default("019d0000-0000-7000-8000-000000000002"),
  SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default("reliacode_session"),
  CSRF_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default("reliacode_csrf"),
  SESSION_COOKIE_SECURE: boolean.default(true),
  ALLOW_INSECURE_HTTP: boolean.default(false),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  SESSION_ROTATION_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),
  PASSKEY_STEP_UP_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  SESSION_FINGERPRINT_KEY: z.string().min(43).optional(),
  SESSION_FINGERPRINT_KEY_FILE: z.string().min(1).optional(),
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
  METRICS_BEARER_TOKEN_FILE: z.string().min(1).optional(),
  WEBHOOK_ENCRYPTION_KEY: z.string().min(43).optional(),
  WEBHOOK_ENCRYPTION_KEY_FILE: z.string().min(1).optional(),
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_REGION: z.string().min(1).default("auto"),
  OBJECT_STORAGE_BUCKET: z.string().min(3).max(63).optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID_FILE: z.string().min(1).optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY_FILE: z.string().min(1).optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: boolean.default(false),
  OTEL_SERVICE_NAME: z.string().min(1).max(100).default("reliacode-api"),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().min(1).optional(),
  OTEL_EXPORTER_OTLP_HEADERS_FILE: z.string().min(1).optional(),
  APP_VERSION: z.string().min(1).max(100).default("development"),
  GIT_SHA: z.string().min(1).max(100).default("unknown")
});

export function loadConfig(env = process.env) {
  const formalProduction = env.DEPLOYMENT_ENVIRONMENT === "production";
  const result = schema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  const config = result.data;
  config.DEPLOYMENT_ENVIRONMENT ||= config.NODE_ENV;
  const sessionFingerprintKey=secretValue(config.SESSION_FINGERPRINT_KEY,config.SESSION_FINGERPRINT_KEY_FILE,"SESSION_FINGERPRINT_KEY");
  const metricsBearerToken=secretValue(config.METRICS_BEARER_TOKEN,config.METRICS_BEARER_TOKEN_FILE,"METRICS_BEARER_TOKEN");
  const webhookEncryptionKey=secretValue(config.WEBHOOK_ENCRYPTION_KEY,config.WEBHOOK_ENCRYPTION_KEY_FILE,"WEBHOOK_ENCRYPTION_KEY");
  if(metricsBearerToken&&metricsBearerToken.length<32)throw new Error("METRICS_BEARER_TOKEN must contain at least 32 characters");
  if (webhookEncryptionKey) {
    const webhookKey=Buffer.from(webhookEncryptionKey, "base64url");
    if (webhookKey.length !== 32 || webhookKey.toString("base64url") !== webhookEncryptionKey) throw new Error("WEBHOOK_ENCRYPTION_KEY must be a canonical base64url-encoded 32-byte key");
  }
  const databaseUrl = config.DATABASE_URL || (config.DATABASE_URL_FILE ? readFileSync(config.DATABASE_URL_FILE, "utf8").trim() : "");
  const systemDatabaseUrl=config.SYSTEM_DATABASE_URL||(config.SYSTEM_DATABASE_URL_FILE?readFileSync(config.SYSTEM_DATABASE_URL_FILE,"utf8").trim():"");
  if (!databaseUrl) throw new Error("DATABASE_URL or DATABASE_URL_FILE is required");
  if (config.NODE_ENV === "production" && !["oidc", "local"].includes(config.AUTH_MODE)) {
    throw new Error("AUTH_MODE must be oidc or local in production");
  }
  if (config.ENABLE_LEGACY_BOOTSTRAP_ADMIN && !config.ADMIN_PASSWORD_HASH) throw new Error("ADMIN_PASSWORD_HASH is required when ENABLE_LEGACY_BOOTSTRAP_ADMIN=true");
  if (config.DEPLOYMENT_ENVIRONMENT === "production" && config.ENABLE_LEGACY_BOOTSTRAP_ADMIN) throw new Error("Legacy bootstrap administrator is forbidden in the production deployment environment");
  if (config.NODE_ENV === "production" && config.AUTH_MODE === "local" && !config.SESSION_COOKIE_SECURE && !config.ALLOW_INSECURE_HTTP) {
    throw new Error("SESSION_COOKIE_SECURE=false requires ALLOW_INSECURE_HTTP=true in production");
  }
  if(sessionFingerprintKey){const fingerprintKey=Buffer.from(sessionFingerprintKey,"base64url");if(fingerprintKey.length!==32||fingerprintKey.toString("base64url")!==sessionFingerprintKey)throw new Error("SESSION_FINGERPRINT_KEY must be a canonical base64url-encoded 32-byte key");}
  if(config.NODE_ENV==="production"&&config.AUTH_MODE==="local"&&!sessionFingerprintKey)throw new Error("SESSION_FINGERPRINT_KEY or SESSION_FINGERPRINT_KEY_FILE is required when AUTH_MODE=local in production");
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
  if (formalProduction) {
    const requireHttps=(value,label)=>{if(value&&new URL(value).protocol!=="https:")throw new Error(`${label} must use HTTPS in the production deployment environment`);};
    if(!config.DATABASE_SSL)throw new Error("DATABASE_SSL=true is required in the production deployment environment");
    if(!systemDatabaseUrl||!config.TENANT_DATABASE_ROLE||!config.SYSTEM_DATABASE_ROLE||config.TENANT_DATABASE_ROLE===config.SYSTEM_DATABASE_ROLE||systemDatabaseUrl===databaseUrl)throw new Error("Formal production requires distinct tenant and trusted system database connections and roles");
    if(decodeURIComponent(new URL(databaseUrl).username)!==config.TENANT_DATABASE_ROLE||decodeURIComponent(new URL(systemDatabaseUrl).username)!==config.SYSTEM_DATABASE_ROLE)throw new Error("Database connection usernames must match TENANT_DATABASE_ROLE and SYSTEM_DATABASE_ROLE");
    if(!config.SESSION_COOKIE_SECURE||config.ALLOW_INSECURE_HTTP)throw new Error("Secure session cookies are required in the production deployment environment");
    if(!config.SESSION_COOKIE_NAME.startsWith("__Host-")||!config.CSRF_COOKIE_NAME.startsWith("__Host-"))throw new Error("Production session and CSRF cookies must use the __Host- prefix");
    if(!config.TRUST_PROXY)throw new Error("TRUST_PROXY=true is required behind the production edge proxy");
    if(!config.SESSION_FINGERPRINT_KEY_FILE||!config.METRICS_BEARER_TOKEN_FILE||!config.WEBHOOK_ENCRYPTION_KEY_FILE)throw new Error("Formal production requires session fingerprint, metrics, and webhook keys to use secret files");
    if(!config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT||!config.OTEL_EXPORTER_OTLP_HEADERS_FILE||config.OTEL_EXPORTER_OTLP_HEADERS)throw new Error("Formal production requires an OTLP HTTPS endpoint with file-backed headers");
    if(!/^[0-9a-f]{40}$/.test(config.GIT_SHA)||config.APP_VERSION!==`sha-${config.GIT_SHA}`)throw new Error("Formal production requires APP_VERSION to match a full immutable GIT_SHA");
    const productionOrigins=[...new Set((config.CORS_ORIGINS+","+(config.PUBLIC_ORIGINS||"")).split(",").map(value=>value.trim()).filter(Boolean))];
    if(!productionOrigins.length||productionOrigins.some(value=>{const parsed=new URL(value);return parsed.protocol!=="https:"||parsed.origin!==value;}))throw new Error("Every production browser origin must be an exact HTTPS origin without a path, query, or credentials");
    requireHttps(config.OIDC_ISSUER_URL,"OIDC_ISSUER_URL");
    requireHttps(config.OPEN_EPCIS_BASE_URL,"OPEN_EPCIS_BASE_URL");
    requireHttps(config.GS1_DIGITAL_LINK_BASE_URL,"GS1_DIGITAL_LINK_BASE_URL");
    if(config.WEBAUTHN_ORIGIN){const origin=new URL(config.WEBAUTHN_ORIGIN);if(origin.protocol!=="https:"||origin.origin!==config.WEBAUTHN_ORIGIN)throw new Error("WEBAUTHN_ORIGIN must be an exact HTTPS origin in the production deployment environment");}
    requireHttps(config.OBJECT_STORAGE_ENDPOINT,"OBJECT_STORAGE_ENDPOINT");
    requireHttps(config.ACCOUNT_RECOVERY_BASE_URL,"ACCOUNT_RECOVERY_BASE_URL");
    requireHttps(config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
    if(smtpUrl&&new URL(smtpUrl).protocol!=="smtps:")throw new Error("SMTP_URL must use SMTPS in the production deployment environment");
  }
  return {
    ...config,
    FORMAL_PRODUCTION:formalProduction,
    ALLOW_PUBLIC_REGISTRATION: config.ALLOW_PUBLIC_REGISTRATION ?? config.NODE_ENV !== "production",
    ENABLE_LEGACY_SYNC_CODE_GENERATION: config.ENABLE_LEGACY_SYNC_CODE_GENERATION ?? config.NODE_ENV !== "production",
    REQUIRE_DEVICE_AUTHORIZATION: config.REQUIRE_DEVICE_AUTHORIZATION ?? config.NODE_ENV === "production",
    DATABASE_URL: databaseUrl,
    SYSTEM_DATABASE_URL:systemDatabaseUrl||undefined,
    SESSION_FINGERPRINT_KEY:sessionFingerprintKey||undefined,
    METRICS_BEARER_TOKEN:metricsBearerToken||undefined,
    WEBHOOK_ENCRYPTION_KEY:webhookEncryptionKey||undefined,
    OBJECT_STORAGE_ACCESS_KEY_ID:objectStorageAccessKeyId||undefined,
    OBJECT_STORAGE_SECRET_ACCESS_KEY:objectStorageSecretAccessKey||undefined,
    objectStorageConfigured:objectStorageValues.every(Boolean),
    SMTP_URL:smtpUrl||undefined,
    OPEN_EPCIS_BEARER_TOKEN:openEpcisBearerToken||undefined,
    emailDeliveryConfigured:emailValues.every(Boolean),
    corsOrigins: [...new Set((config.CORS_ORIGINS + "," + (config.PUBLIC_ORIGINS || "")).split(",").map((value) => value.trim()).filter(Boolean))]
  };
}
