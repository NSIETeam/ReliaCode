import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { createAuthenticator, hashToken } from "./auth.mjs";
import { registerRoutes } from "./routes.mjs";
import { registerSaasRoutes } from "./saas-routes.mjs";
import { registerPasskeyRoutes } from "./passkey-routes.mjs";
import { registerSupplyChainRoutes } from "./supply-chain-routes.mjs";
import { registerWebhookRoutes } from "./webhook-routes.mjs";
import { REQUIRED_SCHEMA_VERSION } from "./schema-version.mjs";
import { observeHttpRequest, renderMetrics } from "./metrics.mjs";
import { rotateLocalSession } from "./session-security.mjs";
import { registerRecoveryRoutes } from "./recovery-routes.mjs";
import { registerManualRecoveryRoutes } from "./manual-recovery-routes.mjs";
import { runWithDatabaseContext,useTenantDatabaseContext,useSystemDatabaseContext } from "./database-context.mjs";
import { ADMIN_PASSKEY_ROLES,hasFreshPasskeyVerification } from "./passkey-policy.mjs";
import { requestId } from "./request-id.mjs";
import { consumeSharedAuthenticationQuota } from "./auth-rate-limit.mjs";
import { registerRewardRoutes } from "./reward-routes.mjs";

const SHARED_AUTHENTICATION_LIMITS=new Map([
  ["/api/auth/passkeys/authentication/options",{scope:"passkey-options",maxRequests:20,windowMs:300_000}],
  ["/api/auth/passkeys/authentication/verify",{scope:"passkey-verify",maxRequests:20,windowMs:300_000}],
  ["/api/auth/recovery-codes/consume",{scope:"recovery-code",maxRequests:10,windowMs:900_000}],
  ["/api/auth/password-reset/request",{scope:"password-reset-request",maxRequests:10,windowMs:3_600_000}],
  ["/api/auth/password-reset/confirm",{scope:"password-reset-confirm",maxRequests:10,windowMs:900_000}],
  ["/api/auth/email-verification/confirm",{scope:"email-verification-confirm",maxRequests:10,windowMs:900_000}],
  ["/api/auth/manual-recovery/confirm",{scope:"manual-recovery-confirm",maxRequests:10,windowMs:900_000}],
  ["/api/v1/tenant-applications",{scope:"tenant-application",maxRequests:10,windowMs:3_600_000}]
]);

export async function buildApp({ config, db }) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-reliacode-device-token", "req.body.password", "req.body.newPassword", "req.body.token", "req.body.credential", "request.body.password", "request.body.newPassword", "request.body.token", "request.body.credential"] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 5 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: (request) => requestId(request.headers["x-request-id"])
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
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id", "X-ReliaCode-Principal", "X-CSRF-Token", "X-ReliaCode-Device-Id", "X-ReliaCode-Device-Token"],
    exposedHeaders:["X-Request-Id","X-CSRF-Token"]
  });
  await app.register(rateLimit, { max: 2400, timeWindow: "1 minute", ban: 3, keyGenerator: (request) => request.ip });

  app.addHook("onRequest",(_request,_reply,done)=>runWithDatabaseContext(done));

  app.addHook("onRequest",async(request,reply)=>{
    if(config.NODE_ENV!=="production"||!config.SESSION_FINGERPRINT_KEY||request.method!=="POST")return;
    const pathname=request.url.split("?",1)[0],policy=SHARED_AUTHENTICATION_LIMITS.get(pathname);
    if(!policy)return;
    const quota=await consumeSharedAuthenticationQuota(db,config.SESSION_FINGERPRINT_KEY,policy.scope,request.ip,policy);
    if(!quota.allowed)return reply.code(429).send({code:"AUTH_RATE_LIMITED",message:"Too many authentication requests",requestId:request.id});
  });

  const authenticate = await createAuthenticator({ ...config, db });
  if (config.NODE_ENV === "production" && config.AUTH_MODE === "local" && !config.SESSION_COOKIE_SECURE) app.log.warn("INSECURE HTTP session cookies are enabled; use HTTPS as soon as possible");
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?",1)[0];
    const invitationAccept = pathname === "/api/auth/invitations/accept";
    const passwordReset = pathname === "/api/auth/password-reset/request" || pathname === "/api/auth/password-reset/confirm" || pathname==="/api/auth/email-verification/confirm" || pathname==="/api/auth/manual-recovery/confirm";
    const hasAuthCredentials = Boolean(request.headers.authorization || request.headers.cookie);
    const passkeyLogin = pathname === "/api/auth/passkeys/authentication/options" || pathname === "/api/auth/passkeys/authentication/verify";
    const recoveryCodeLogin=pathname==="/api/auth/recovery-codes/consume";
    if (request.url === "/health/live" || request.url === "/health/ready" || pathname === "/metrics" || request.url.startsWith("/api/public/") || request.url === "/api/auth/login" || request.url === "/api/auth/register" || pathname === "/api/v1/tenant-applications" || passkeyLogin || recoveryCodeLogin || passwordReset || (invitationAccept && !hasAuthCredentials)) return;
    try { request.principal = await authenticate(request); } catch (error) {
      request.log.warn({ error: error.message }, "authentication failed");
    }
    if (!request.principal) return reply.code(401).send({ code:"UNAUTHORIZED", message:"A valid access token is required", requestId:request.id });
    if(request.principal.role==="PLATFORM_OPERATOR")useSystemDatabaseContext();else useTenantDatabaseContext(request.principal.tenantId);
    if (config.AUTH_MODE === "local") {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        const origin = request.headers.origin;
        if (origin && !config.corsOrigins.includes(origin)) return reply.code(403).send({ code:"ORIGIN_NOT_ALLOWED", message:"Origin is not allowed", requestId:request.id });
        const supplied = String(request.headers["x-csrf-token"] || "");
        if (!supplied || hashToken(supplied) !== request.authSession.csrf_token_hash) return reply.code(403).send({ code:"CSRF_INVALID", message:"CSRF token is invalid", requestId:request.id });
        if (pathname.startsWith("/api/v1/") && ADMIN_PASSKEY_ROLES.has(request.principal.role) && request.principal.id !== "local-admin") {
          const passkeys=await db.query("SELECT count(*)::int count FROM webauthn_credentials WHERE user_id=$1",[request.principal.id]);
          if(Number(passkeys.rows[0]?.count||0)<2)return reply.code(428).send({code:"ADMIN_PASSKEYS_REQUIRED",message:"Administrators must register at least two Passkeys before sensitive operations",requestId:request.id});
          if(!hasFreshPasskeyVerification(request.authSession,config.PASSKEY_STEP_UP_MINUTES))return reply.code(428).send({code:"PASSKEY_STEP_UP_REQUIRED",message:"A recent Passkey verification is required for this operation",requestId:request.id});
        }
      }
      if(pathname!=="/api/auth/session")await rotateLocalSession(db,config,request,reply);
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
        `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1) AS current,
          r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user`,
        [REQUIRED_SCHEMA_VERSION]
      );
      if (!migration.rows[0]?.current) {
        return reply.code(503).send({ status:"not_ready", reason:"schema_outdated" });
      }
      if(migration.rows[0].rolsuper||migration.rows[0].rolbypassrls)return reply.code(503).send({status:"not_ready",reason:"database_role_bypasses_rls"});
      if(config.FORMAL_PRODUCTION){
        const isolation=await db.isolationStatus();
        if(!isolation.distinct||isolation.tenant?.system_access||!isolation.system?.system_access||isolation.tenant?.role_name!==config.TENANT_DATABASE_ROLE||isolation.system?.role_name!==config.SYSTEM_DATABASE_ROLE||isolation.tenant?.rolsuper||isolation.tenant?.rolbypassrls||isolation.system?.rolsuper||isolation.system?.rolbypassrls)return reply.code(503).send({status:"not_ready",reason:"database_role_isolation_invalid"});
      }
      return { status:"ready", schemaVersion:REQUIRED_SCHEMA_VERSION, deploymentEnvironment:config.DEPLOYMENT_ENVIRONMENT || config.NODE_ENV };
    }
    catch { return reply.code(503).send({ status:"not_ready" }); }
  });
  app.get("/metrics",async(request,reply)=>{if(!config.METRICS_BEARER_TOKEN||request.headers.authorization!==`Bearer ${config.METRICS_BEARER_TOKEN}`)return reply.code(404).send({code:"NOT_FOUND",message:"Route not found"});reply.type("text/plain; version=0.0.4; charset=utf-8");return renderMetrics(db);});
  registerRoutes(app, { db, config });
  registerSaasRoutes(app, { db, config });
  registerPasskeyRoutes(app, { db, config });
  registerSupplyChainRoutes(app, { db, config });
  registerWebhookRoutes(app, { db, config });
  registerRecoveryRoutes(app,{db,config});
  registerManualRecoveryRoutes(app,{db});
  registerRewardRoutes(app,{db,config});

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
