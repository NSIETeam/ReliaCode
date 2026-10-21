# Production operations and recovery controls

This runbook is for an operator with access to the production platform. It contains no credentials. Replace example URLs and storage locations with approved values; never paste secrets into a shell command or ticket.

## Service objectives and alerts

- Target RPO: 24 hours for the daily logical backup; target RTO: 4 hours for API and database recovery. The managed PostgreSQL provider's PITR objective must be recorded in the service contract.
- Page on `/health/live` failure for 2 consecutive checks, `/health/ready` failure for 3 checks, HTTP 5xx above 1% for 5 minutes, or database storage above 80%.
- Page the owner when `reliacode_epcis_oldest_pending_age_seconds` exceeds 300 or `reliacode_epcis_max_attempts` grows continuously. Alert on nonzero `reliacode_database_pool_waiting` and sustained pool saturation. Do not delete outbox rows to clear an alert.
- Ticket (not page) for a missed backup, backup checksum failure, or backup older than 25 hours; escalate to the incident commander if not fixed within 1 hour.

## Daily backup

1. On the approved production host, run `backup-postgres.sh` with `DATABASE_URL_FILE`, `BACKUP_S3_URI`, and the public `BACKUP_AGE_RECIPIENT`. The target bucket must have object versioning enabled. The script uploads only an age-encrypted dump and its SHA256 manifest, resolves both VersionIds, then records `VERIFIED` after both uploads succeed.
2. Confirm the corresponding `backup_runs` row is `VERIFIED` and record the immutable object version or retention-lock identifier. Keep at least 30 daily copies and one monthly copy.
3. On an isolated recovery host, download the `.dump.age` object and `.sha256` sidecar, then run `verify-backup.sh <dump.age> <dump.age.sha256> <offline-age-identity-file>`. This verifies ciphertext before decryption and runs `pg_restore --list` only on the decrypted archive.
4. Record timestamp, operator, object-storage version/id, checksum result, and retention expiry in the backup log. The log must not contain a connection string. The age identity must never be copied to the production host.

Acceptance: a non-empty encrypted dump and SHA256 sidecar exist in two independent locations, the downloaded ciphertext passes `sha256sum --check`, and the decrypted archive passes `pg_restore --list`.

## Monthly recovery rehearsal (isolated target only)

1. Provision a disposable PostgreSQL instance or isolated project with network access disabled from production and with outbound payment/channel integrations disabled.
2. Supply the exact archive and manifest VersionIds recorded in `backup_runs`; verify the selected ciphertext checksum, restore it with `pg_restore --clean --if-exists` into the isolated database, and run the schema migration check.
3. Check representative counts for tenants, trace events, claims, ledger entries, audit events, and pending outbox rows. Compare with the backup log; do not edit source records.
4. Start API/worker against the isolated database and run read-only health checks plus a synthetic scan using test identifiers. Confirm no real notification, payment, or EPCIS destination is reachable.
5. Measure restore and service recovery time, capture evidence, then destroy the disposable target according to the platform's retention policy.

Acceptance: restore completes within 4 hours, checksums and row-level reconciliation pass, `/health/live` and `/health/ready` return 200, and the signed rehearsal record includes RPO/RTO measurements and follow-up actions.

## Release, rollback, and incident sequence

Production images are published only with immutable `sha-<git-sha>` tags. Both
the API and Web images must pass fixable high/critical vulnerability scans.
Runtime containers use a read-only root filesystem, drop all Linux capabilities,
enable `no-new-privileges`, and expose application ports only on host loopback
for the reverse proxy.
The production workflow is manual-only and additionally requires approval in
the GitHub `production` Environment; a push to `main` cannot deploy the server.

The release script records the currently running API and Web image references
before deployment. If the new release does not pass API readiness and Web
liveness checks, or either health response reports a revision different from
the requested full Git SHA, it restores the complete previous application image
set and checks it again. A rollback is accepted only when the previous API and
Web images carry the same immutable SHA. Database migrations are forward-only, so every migration must
remain compatible with the immediately preceding application release.

1. Before release, verify the immutable image digest, migration plan, current backup age, and healthy `/health/ready`. Record the operator and change ID.
2. Run migrations once, then roll the API and worker. Watch health, 5xx/P95, database connections, and outbox age for 15 minutes.
3. If thresholds breach, stop rollout and route traffic to the last known-good immutable image digest. Do not run a down migration automatically.
4. If data shape changed, restore only in an isolated environment first; use a forward-compatible repair or compensating event after review. Never rewrite or delete trace, audit, ledger, or outbox history to mask an incident.
5. Close the incident with timeline, alert evidence, affected tenant scope, backup/recovery result, and a prevention action.

Acceptance: every release has a health baseline and rollback digest; every rollback has an incident/change record; recovery actions preserve append-only auditability.
