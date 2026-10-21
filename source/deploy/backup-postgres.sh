#!/bin/sh
set -eu

: "${DATABASE_URL_FILE:?DATABASE_URL_FILE is required}"
: "${BACKUP_S3_URI:?BACKUP_S3_URI is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
test -s "$DATABASE_URL_FILE"
command -v pg_dump >/dev/null
command -v psql >/dev/null
command -v age >/dev/null
command -v aws >/dev/null
command -v sha256sum >/dev/null

backup_tmp=$(mktemp -d "${TMPDIR:-/tmp}/reliacode-backup.XXXXXX")
trap 'rm -rf -- "$backup_tmp"' EXIT HUP INT TERM
database_url=$(tr -d '\r\n' < "$DATABASE_URL_FILE")
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_tmp/reliacode-$stamp.dump"
encrypted="$archive.age"
manifest="$encrypted.sha256"
object_uri="${BACKUP_S3_URI%/}/$(basename "$encrypted")"
manifest_uri="$object_uri.sha256"
case "$object_uri" in s3://*/*) ;; *) echo "BACKUP_S3_URI must use s3://bucket/prefix" >&2; exit 2;; esac
s3_path=${object_uri#s3://}
bucket=${s3_path%%/*}
object_key=${s3_path#*/}
manifest_key="$object_key.sha256"

pg_dump --dbname="$database_url" --format=custom --compress=9 --no-owner --no-acl --file="$archive"
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted" "$archive"
checksum=$(sha256sum "$encrypted" | awk '{print $1}')
size_bytes=$(wc -c < "$encrypted" | tr -d ' ')
printf '%s  %s\n' "$checksum" "$(basename "$encrypted")" > "$manifest"
aws s3 cp "$encrypted" "$object_uri" --only-show-errors --sse AES256
aws s3 cp "$manifest" "$manifest_uri" --only-show-errors --sse AES256
archive_version_id=$(aws s3api head-object --bucket "$bucket" --key "$object_key" --query VersionId --output text)
manifest_version_id=$(aws s3api head-object --bucket "$bucket" --key "$manifest_key" --query VersionId --output text)
case "$archive_version_id:$manifest_version_id" in *None*|*null*|:*|*:) echo "Backup bucket versioning is required" >&2; exit 1;; esac
# The restore path performs the authoritative content check after download. Both
# uploads must succeed before the database advertises a verified offsite backup.
psql "$database_url" -v ON_ERROR_STOP=1 -v object_uri="$object_uri" -v checksum="$checksum" -v size_bytes="$size_bytes" -v archive_version_id="$archive_version_id" -v manifest_version_id="$manifest_version_id" \
  -c "INSERT INTO backup_runs(object_key,checksum_sha256,size_bytes,status,archive_version_id,manifest_version_id) VALUES (:'object_uri',:'checksum',:'size_bytes'::bigint,'VERIFIED',:'archive_version_id',:'manifest_version_id')"
printf 'Uploaded encrypted backup and checksum manifest %s (%s bytes, sha256 %s)\n' "$object_uri" "$size_bytes" "$checksum"
