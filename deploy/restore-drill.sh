#!/bin/sh
set -eu

: "${BACKUP_OBJECT_URI:?BACKUP_OBJECT_URI is required}"
: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE is required}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL must point to an isolated drill database}"
case "$RESTORE_DATABASE_URL" in *reliacode_drill*) ;; *) echo "RESTORE_DATABASE_URL must contain reliacode_drill" >&2; exit 2;; esac
command -v aws >/dev/null
command -v age >/dev/null
command -v pg_restore >/dev/null
command -v psql >/dev/null

restore_tmp=$(mktemp -d "${TMPDIR:-/tmp}/reliacode-restore.XXXXXX")
trap 'rm -rf -- "$restore_tmp"' EXIT HUP INT TERM
encrypted="$restore_tmp/backup.dump.age"
archive="$restore_tmp/backup.dump"
aws s3 cp "$BACKUP_OBJECT_URI" "$encrypted" --only-show-errors
age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$archive" "$encrypted"
pg_restore --dbname="$RESTORE_DATABASE_URL" --clean --if-exists --no-owner --no-acl --exit-on-error "$archive"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS migrations FROM schema_migrations; SELECT count(*) AS tenants FROM tenants;"
printf 'Restore drill completed from %s\n' "$BACKUP_OBJECT_URI"
