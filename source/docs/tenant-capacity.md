# Tenant capacity and storage baseline

ReliaCode uses one PostgreSQL schema shared by tenants. Domain records carry
`tenant_id`; local identity rows remain compact and workspaces are stored once
per organization. This avoids per-tenant database overhead.

## Initial operating envelope

Target 100 active enterprises, about 1,000 local users, and 20--50 concurrent
operators. Provision and measure for 5--15 sustained trace writes per second
with short bursts up to 30 per second. These are operating targets, not an SLA.

Run the dependency-free guard:

```text
node deploy/capacity-baseline.mjs --tenants 100 --users-per-tenant 10 --requests 20000 --concurrency 100
```

The script checks tenant isolation and reports p95 lookup and heap use. Release
acceptance must additionally run against production-like PostgreSQL with
representative trace-event volume.
