import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { createAuthenticator } from "./auth.mjs";
import { registerRoutes } from "./routes.mjs";

export async function buildApp({ config, db }) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie", "request.body.password", "request.body.token"] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1_048_576,
    requestIdHeader: "x-request-id",
    genReqId: (request) => request.headers["x-request-id"] || randomUUID()
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.NODE_ENV === "production" ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false
  });
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin is not allowed"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id", "X-ReliaCode-Principal"]
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute", ban: 3, keyGenerator: (request) => request.ip });

  const authenticate = await createAuthenticator(config);
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health/live" || request.url === "/health/ready" || request.url.startsWith("/api/public/")) return;
    try { request.principal = await authenticate(request); } catch (error) {
      request.log.warn({ error: error.message }, "authentication failed");
    }
    if (!request.principal) return reply.code(401).send({ code:"UNAUTHORIZED", message:"A valid access token is required", requestId:request.id });
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

  app.get("/health/live", async () => ({ status:"ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try { await db.query("SELECT 1"); return { status:"ready" }; }
    catch { return reply.code(503).send({ status:"not_ready" }); }
  });
  registerRoutes(app, { db });

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
