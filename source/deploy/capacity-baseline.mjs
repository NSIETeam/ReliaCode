#!/usr/bin/env node
// Dependency-free synthetic tenant lookup baseline; not a production load test.
import { performance } from "node:perf_hooks";
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? Number(process.argv[i + 1]) : fallback; };
const tenants = arg("tenants", 100);
const usersPerTenant = arg("users-per-tenant", 10);
const requests = arg("requests", 20_000);
const concurrency = arg("concurrency", 100);
if (![tenants, usersPerTenant, requests, concurrency].every(Number.isInteger) || tenants < 1 || tenants > 1000 || usersPerTenant < 1 || requests < 1 || concurrency < 1) throw new Error("arguments must be positive integers; tenants must be <= 1000");
const usersByTenant = new Map();
for (let tenant = 0; tenant < tenants; tenant += 1) {
  const users = new Map();
  for (let user = 0; user < usersPerTenant; user += 1) users.set(`user-${tenant}-${user}`, { tenantId: tenant, userId: user });
  usersByTenant.set(tenant, users);
}
let next = 0; let completed = 0; const durations = [];
const worker = async () => { while (true) { const request = next++; if (request >= requests) return; const tenantId = request % tenants; const userId = request % usersPerTenant; const started = performance.now(); const row = usersByTenant.get(tenantId)?.get(`user-${tenantId}-${userId}`); if (!row || row.tenantId !== tenantId) throw new Error("tenant isolation check failed"); durations.push(performance.now() - started); completed += 1; if (completed % 1000 === 0) await Promise.resolve(); } };
const started = performance.now();
await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
durations.sort((a, b) => a - b);
const percentile = (p) => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))];
const elapsedMs = performance.now() - started;
process.stdout.write(`${JSON.stringify({ tenants, users: tenants * usersPerTenant, requests, concurrency: Math.min(concurrency, requests), elapsedMs: Number(elapsedMs.toFixed(2)), requestsPerSecond: Number((requests / (elapsedMs / 1000)).toFixed(1)), lookupP95Ms: Number(percentile(0.95).toFixed(4)), heapUsedMb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)), tenantIsolation: "passed" })}\n`);
