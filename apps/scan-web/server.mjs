import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const apiBaseUrl = process.env.RELIACODE_API_URL ? new URL(process.env.RELIACODE_API_URL) : null;
const types = {
  ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"application/javascript; charset=utf-8",
  ".svg":"image/svg+xml", ".json":"application/json; charset=utf-8", ".png":"image/png", ".webp":"image/webp"
};
const securityHeaders = {
  "Content-Security-Policy":"default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  "Referrer-Policy":"strict-origin-when-cross-origin", "X-Content-Type-Options":"nosniff", "X-Frame-Options":"DENY",
  "Permissions-Policy":"camera=(self), geolocation=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy":"same-origin", "Cross-Origin-Resource-Policy":"same-origin"
};

export function runtimeConfig({ persistentWorkspace = false, domainApi = Boolean(apiBaseUrl) } = {}) {
  return `window.RELIACODE_CONFIG = Object.freeze(${JSON.stringify({
    apiBaseUrl: "",
    persistentWorkspace:Boolean(persistentWorkspace),
    domainApi:Boolean(domainApi)
  })});\n`;
}

function writeHeaders(response, extra = {}) {
  for (const [name, value] of Object.entries({ ...securityHeaders, ...extra })) response.setHeader(name, value);
}

function proxy(request, response) {
  if (!apiBaseUrl) {
    writeHeaders(response, { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store" });
    response.writeHead(503).end(JSON.stringify({ code:"API_UNAVAILABLE", message:"ReliaCode API is not configured" }));
    return;
  }
  const target = new URL(request.url, apiBaseUrl);
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = { ...request.headers, host:target.host, "x-forwarded-host":request.headers.host || "", "x-forwarded-proto":"http" };
  const upstream = transport(target, { method:request.method, headers, timeout:15_000 }, (upstreamResponse) => {
    writeHeaders(response, { "Cache-Control":"no-store" });
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (response.headersSent) return response.destroy();
    writeHeaders(response, { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store" });
    response.writeHead(502).end(JSON.stringify({ code:"API_GATEWAY_ERROR", message:"ReliaCode API is unavailable" }));
  });
  request.pipe(upstream);
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/") || pathname === "/health/ready") return proxy(request, response);
  if (pathname === "/health/live") {
    writeHeaders(response, { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store" });
    response.writeHead(200).end(JSON.stringify({ status:"ok" }));
    return;
  }
  if (pathname === "/runtime-config.js") {
    writeHeaders(response, { "Content-Type":"application/javascript; charset=utf-8", "Cache-Control":"no-store" });
    response.writeHead(200).end(runtimeConfig());
    return;
  }
  if (!["GET","HEAD"].includes(request.method)) {
    writeHeaders(response, { Allow:"GET, HEAD" }); response.writeHead(405).end(); return;
  }
  let decoded;
  try { decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname); }
  catch { writeHeaders(response); response.writeHead(400).end("Bad request"); return; }
  const target = resolve(root, `.${decoded}`);
  if (!target.startsWith(`${root}${sep}`) || !existsSync(target) || !statSync(target).isFile()) {
    writeHeaders(response, { "Content-Type":"text/plain; charset=utf-8" }); response.writeHead(404).end("Not found"); return;
  }
  const extension = extname(target);
  writeHeaders(response, { "Content-Type":types[extension] || "application/octet-stream", "Cache-Control":extension === ".html" ? "no-cache" : "public, max-age=3600" });
  response.writeHead(200);
  if (request.method === "HEAD") return response.end();
  createReadStream(target).pipe(response);
});

server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.listen(port, host, () => console.log(JSON.stringify({ level:"info", service:"reliacode-web", url:`http://localhost:${port}`, apiConfigured:Boolean(apiBaseUrl) })));
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
