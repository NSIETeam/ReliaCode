# Tenant storage and operations

Use one shared PostgreSQL schema with tenant-leading indexes. Keep identity
rows compact: one local user row, one membership row per organization, and one
workspace row per organization.

The initial operating target is 100 active enterprises, 1,000 users, and 20--50
concurrent operators. Production compose uses an eight-connection API pool and
a two-connection outbox pool. Keep provider connection limits above active
replicas plus workers and operator headroom.

Trace, ledger and audit records are append-only. Keep 12 months hot, then
archive older trace/audit data to encrypted access-controlled object storage
after tenant-scoped counts and recovery evidence are recorded. Keep 30 daily
and one monthly encrypted backup; verify and restore monthly.

