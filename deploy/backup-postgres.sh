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

backup_tmp=$(mktemp -d "${TMPDIR:-/tmp}/reliacode-backup.XXXXXX")
trap 'rm -rf -- "$backup_tmp"' EXIT HUP INT TERM
database_url=$(tr -d '\r\n' < "$DATABASE_URL_FILE")
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_tmp/reliacode-$stamp.dump"
encrypted="$archive.age"
object_uri="${BACKUP_S3_URI%/}/$(basename "$encrypted")"

pg_dump --dbname="$database_url" --format=custom --compress=9 --no-owner --no-acl --file="$archive"
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted" "$archive"
checksum=$(shasum -a 256 "$encrypted" | awk '{print $1}')
size_bytes=$(wc -c < "$encrypted" | tr -d ' ')
aws s3 cp "$encrypted" "$object_uri" --only-show-errors --sse AES256
psql "$database_url" -v ON_ERROR_STOP=1 -c "INSERT INTO backup_runs(object_key,checksum_sha256,size_bytes,status) VALUES ('$(printf %s "$object_uri" | sed "s/'/''/g")','$checksum',$size_bytes,'COMPLETED')"
printf 'Uploaded encrypted backup %s (%s bytes, sha256 %s)\n' "$object_uri" "$size_bytes" "$checksum"
