import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { createAuthenticator, hashToken } from "./auth.mjs";
import { registerRoutes } from "./routes.mjs";
import { registerSaasRoutes } from "./saas-routes.mjs";
import { registerPasskeyRoutes } from "./passkey-routes.mjs";
import { registerSupplyChainRoutes } from "./supply-chain-routes.mjs";
import { registerWebhookRoutes } from "./webhook-routes.mjs";
import { REQUIRED_SCHEMA_VERSION } from "./schema-version.mjs";
import { observeHttpRequest, renderMetrics } from "./metrics.mjs";

export async function buildApp({ config, db }) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie", "request.body.password", "request.body.token"] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 5 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: (request) => request.headers["x-request-id"] || randomUUID()
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.NODE_ENV === "production" && config.SESSION_COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false
  });
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id", "X-ReliaCode-Principal", "X-CSRF-Token"]
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute", ban: 3, keyGenerator: (request) => request.ip });

  const authenticate = await createAuthenticator({ ...config, db });
  const loginAttempts = new Map();
  if (config.NODE_ENV === "production" && config.AUTH_MODE === "local" && !config.SESSION_COOKIE_SECURE) app.log.warn("INSECURE HTTP session cookies are enabled; use HTTPS as soon as possible");
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?",1)[0];
    const invitationAccept = pathname === "/api/auth/invitations/accept";
    const passwordReset = pathname === "/api/auth/password-reset/request" || pathname === "/api/auth/password-reset/confirm";
    const hasAuthCredentials = Boolean(request.headers.authorization || request.headers.cookie);
    const passkeyLogin = pathname === "/api/auth/passkeys/authentication/options" || pathname === "/api/auth/passkeys/authentication/verify";
    const recoveryCodeLogin=pathname==="/api/auth/recovery-codes/consume";
    if (request.url === "/health/live" || request.url === "/health/ready" || pathname === "/metrics" || request.url.startsWith("/api/public/") || request.url === "/api/auth/login" || request.url === "/api/auth/register" || pathname === "/api/v1/tenant-applications" || passkeyLogin || recoveryCodeLogin || passwordReset || (invitationAccept && !hasAuthCredentials)) return;
    try { request.principal = await authenticate(request); } catch (error) {
      request.log.warn({ error: error.message }, "authentication failed");
    }
    if (!request.principal) return reply.code(401).send({ code:"UNAUTHORIZED", message:"A valid access token is required", requestId:request.id });
    if (config.AUTH_MODE === "local") {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        const origin = request.headers.origin;
        if (origin && !config.corsOrigins.includes(origin)) return reply.code(403).send({ code:"ORIGIN_NOT_ALLOWED", message:"Origin is not allowed", requestId:request.id });
        const supplied = String(request.headers["x-csrf-token"] || "");
        if (!supplied || hashToken(supplied) !== request.authSession.csrf_token_hash) return reply.code(403).send({ code:"CSRF_INVALID", message:"CSRF token is invalid", requestId:request.id });
        if (pathname.startsWith("/api/v1/") && ["BRAND_ADMIN","TENANT_OWNER"].includes(request.principal.role) && request.principal.id !== "local-admin") {
          const passkeys=await db.query("SELECT count(*)::int count FROM webauthn_credentials WHERE user_id=$1",[request.principal.id]);
          if(Number(passkeys.rows[0]?.count||0)<2)return reply.code(428).send({code:"ADMIN_PASSKEYS_REQUIRED",message:"Administrators must register at least two Passkeys before sensitive operations",requestId:request.id});
        }
      }
      return;
    }
    const scope = await db.query(
      `SELECT EXISTS(SELECT 1 FROM tenants t JOIN organizations o ON o.tenant_id=t.id
       WHERE t.id=$1 AND o.id=$2 AND t.status='ACTIVE' AND o.status='ACTIVE') active`,
      [request.principal.tenantId, request.principal.organizationId]
    );
    if (!scope.rows[0]?.active) {
      return reply.code(403).send({ code:"PRINCIPAL_SCOPE_INACTIVE", message:"Tenant or organization is not active", requestId:request.id });
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    reply.header("cache-control", request.url.startsWith("/api/public/") ? "public, max-age=60, stale-while-revalidate=300" : request.method === "GET" ? "private, no-store" : "no-store");
    return payload;
  });
  app.addHook("onResponse",async(request,reply)=>{observeHttpRequest(request.method,request.routeOptions?.url||"unmatched",reply.statusCode,reply.elapsedTime/1000);});

  app.get("/health/live", async () => ({
    status:"ok",
    service:"reliacode-scan-api",
    version:config.APP_VERSION,
    revision:config.GIT_SHA
  }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      const migration = await db.query(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1) AS current",
        [REQUIRED_SCHEMA_VERSION]
      );
      if (!migration.rows[0]?.current) {
        return reply.code(503).send({ status:"not_ready", reason:"schema_outdated" });
      }
      return { status:"ready", schemaVersion:REQUIRED_SCHEMA_VERSION };
    }
    catch { return reply.code(503).send({ status:"not_ready" }); }
  });
  app.get("/metrics",async(request,reply)=>{if(!config.METRICS_BEARER_TOKEN||request.headers.authorization!==`Bearer ${config.METRICS_BEARER_TOKEN}`)return reply.code(404).send({code:"NOT_FOUND",message:"Route not found"});reply.type("text/plain; version=0.0.4; charset=utf-8");return renderMetrics(db);});
  registerRoutes(app, { db, config, loginAttempts });
  registerSaasRoutes(app, { db, config });
  registerPasskeyRoutes(app, { db, config });
  registerSupplyChainRoutes(app, { db, config });
  registerWebhookRoutes(app, { db, config });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ code:"NOT_FOUND", message:"Route not found", requestId:request.id }));
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof ZodError ? 400 : Number(error.statusCode) || 500;
    const code = error instanceof ZodError ? "VALIDATION_ERROR" : error.code || "INTERNAL_ERROR";
    if (statusCode >= 500) request.log.error({ err:error }, "request failed");
    else request.log.info({ code, message:error.message }, "request rejected");
    return reply.code(statusCode).send({
      code,
      message: statusCode >= 500 ? "Internal server error" : error.message,
      details: error instanceof ZodError ? error.issues.map((issue) => ({ path:issue.path.join("."), message:issue.message })) : undefined,
      requestId: request.id
    });
  });
  return app;
}
