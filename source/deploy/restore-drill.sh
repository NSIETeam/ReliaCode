#!/bin/sh
set -eu

: "${BACKUP_OBJECT_URI:?BACKUP_OBJECT_URI is required}"
: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE is required}"
: "${BACKUP_OBJECT_VERSION_ID:?BACKUP_OBJECT_VERSION_ID is required}"
: "${BACKUP_MANIFEST_VERSION_ID:?BACKUP_MANIFEST_VERSION_ID is required}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL must point to an isolated drill database}"
: "${REQUIRED_SCHEMA_VERSION:=034_reward_reconciliation_exports.sql}"
case "$RESTORE_DATABASE_URL" in *reliacode_drill*) ;; *) echo "RESTORE_DATABASE_URL must contain reliacode_drill" >&2; exit 2;; esac
command -v aws >/dev/null
command -v age >/dev/null
command -v pg_restore >/dev/null
command -v psql >/dev/null
command -v sha256sum >/dev/null

restore_tmp=$(mktemp -d "${TMPDIR:-/tmp}/reliacode-restore.XXXXXX")
trap 'rm -rf -- "$restore_tmp"' EXIT HUP INT TERM
encrypted="$restore_tmp/$(basename "$BACKUP_OBJECT_URI")"
manifest="$encrypted.sha256"
archive="$restore_tmp/backup.dump"
manifest_uri=${BACKUP_MANIFEST_URI:-$BACKUP_OBJECT_URI.sha256}
case "$BACKUP_OBJECT_URI" in s3://*/*) ;; *) echo "BACKUP_OBJECT_URI must use s3://bucket/key" >&2; exit 2;; esac
case "$manifest_uri" in s3://*/*) ;; *) echo "BACKUP_MANIFEST_URI must use s3://bucket/key" >&2; exit 2;; esac
object_path=${BACKUP_OBJECT_URI#s3://}; object_bucket=${object_path%%/*}; object_key=${object_path#*/}
manifest_path_value=${manifest_uri#s3://}; manifest_bucket=${manifest_path_value%%/*}; manifest_key=${manifest_path_value#*/}
aws s3api get-object --bucket "$object_bucket" --key "$object_key" --version-id "$BACKUP_OBJECT_VERSION_ID" "$encrypted" >/dev/null
aws s3api get-object --bucket "$manifest_bucket" --key "$manifest_key" --version-id "$BACKUP_MANIFEST_VERSION_ID" "$manifest" >/dev/null
test "$(wc -l < "$manifest" | tr -d ' ')" = 1 || { echo "Backup manifest must contain exactly one line" >&2; exit 1; }
manifest_checksum=$(awk 'NF==2 {print $1}' "$manifest")
manifest_name=$(awk 'NF==2 {print $2}' "$manifest")
printf '%s' "$manifest_checksum" | grep -Eq '^[0-9a-f]{64}$' || { echo "Backup manifest checksum is invalid" >&2; exit 1; }
test "$manifest_name" = "$(basename "$encrypted")" || { echo "Backup manifest filename does not match ciphertext" >&2; exit 1; }
(cd "$restore_tmp" && printf '%s  %s\n' "$manifest_checksum" "$manifest_name" | sha256sum --check --strict -)
age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$archive" "$encrypted"
pg_restore --list "$archive" >/dev/null
pg_restore --dbname="$RESTORE_DATABASE_URL" --clean --if-exists --no-owner --no-acl --exit-on-error "$archive"
schema_present=$(psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -v required_schema_version="$REQUIRED_SCHEMA_VERSION" -Atc "SELECT count(*) FROM schema_migrations WHERE version=:'required_schema_version'")
test "$schema_present" = 1 || { echo "Required schema migration is missing: $REQUIRED_SCHEMA_VERSION" >&2; exit 1; }
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN ('products'::regclass,'serialized_objects'::regclass,'trace_events'::regclass)
      AND (NOT relrowsecurity OR NOT relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'tenant tables are not protected by forced RLS';
  END IF;
END $$;
SELECT count(*) AS migrations FROM schema_migrations;
SELECT count(*) AS tenants FROM tenants;
SELECT count(*) AS trace_events FROM trace_events;
SELECT count(*) AS audit_events FROM audit_events;
SQL
printf 'Restore drill completed from %s\n' "$BACKUP_OBJECT_URI"
