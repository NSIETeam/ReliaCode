# Production operations and recovery controls

This runbook is for an operator with access to the production platform. It contains no credentials. Replace example URLs and storage locations with approved values; never paste secrets into a shell command or ticket.

## Service objectives and alerts

- Target RPO: 24 hours for the daily logical backup; target RTO: 4 hours for API and database recovery. The managed PostgreSQL provider's PITR objective must be recorded in the service contract.
- Page on `/health/live` failure for 2 consecutive checks, `/health/ready` failure for 3 checks, HTTP 5xx above 1% for 5 minutes, or database storage above 80%.
- Page the owner when outbox oldest age exceeds 5 minutes or failed attempts grow continuously. Do not delete outbox rows to clear an alert.
- Ticket (not page) for a missed backup, backup checksum failure, or backup older than 25 hours; escalate to the incident commander if not fixed within 1 hour.

## Daily backup

1. On the approved host, run `./deploy/backup-postgres.ps1 -ComposeFile deploy/compose.production.yaml -EnvFile deploy/.env -OutputDir <protected-backup-dir>`.
2. Run `./deploy/verify-backup.ps1 -BackupFile <protected-backup-dir>/reliacode-<timestamp>.dump`.
3. Copy the dump and `.sha256` sidecar to encrypted, access-controlled off-host storage. Keep at least 30 daily copies and one monthly copy.
4. Record timestamp, operator, object-storage version/id, checksum result, and retention expiry in the change/backup log. The log must not contain a connection string.

Acceptance: a non-empty dump exists in two independent locations, its SHA256 sidecar matches, and `pg_restore --list` succeeds.

## Monthly recovery rehearsal (isolated target only)

1. Provision a disposable PostgreSQL instance or isolated project with network access disabled from production and with outbound payment/channel integrations disabled.
2. Verify the selected dump checksum, restore it with `pg_restore --clean --if-exists` into the isolated database, and run the schema migration check.
3. Check representative counts for tenants, trace events, claims, ledger entries, audit events, and pending outbox rows. Compare with the backup log; do not edit source records.
4. Start API/worker against the isolated database and run read-only health checks plus a synthetic scan using test identifiers. Confirm no real notification, payment, or EPCIS destination is reachable.
5. Measure restore and service recovery time, capture evidence, then destroy the disposable target according to the platform's retention policy.

Acceptance: restore completes within 4 hours, checksums and row-level reconciliation pass, `/health/live` and `/health/ready` return 200, and the signed rehearsal record includes RPO/RTO measurements and follow-up actions.

## Release, rollback, and incident sequence

1. Before release, verify the immutable image digest, migration plan, current backup age, and healthy `/health/ready`. Record the operator and change ID.
2. Run migrations once, then roll the API and worker. Watch health, 5xx/P95, database connections, and outbox age for 15 minutes.
3. If thresholds breach, stop rollout and route traffic to the last known-good immutable image digest. Do not run a down migration automatically.
4. If data shape changed, restore only in an isolated environment first; use a forward-compatible repair or compensating event after review. Never rewrite or delete trace, audit, ledger, or outbox history to mask an incident.
5. Close the incident with timeline, alert evidence, affected tenant scope, backup/recovery result, and a prevention action.

Acceptance: every release has a health baseline and rollback digest; every rollback has an incident/change record; recovery actions preserve append-only auditability.
