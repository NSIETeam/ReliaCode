#!/bin/sh
set -eu

: "${1:?usage: verify-backup.sh BACKUP_FILE [MANIFEST_FILE] [AGE_IDENTITY_FILE]}"
backup=$1
manifest=${2:-$backup.sha256}
identity=${3:-}
test -s "$backup"
test -s "$manifest"
command -v pg_restore >/dev/null
command -v sha256sum >/dev/null

backup_dir=$(CDPATH= cd -- "$(dirname -- "$backup")" && pwd)
manifest_path=$(CDPATH= cd -- "$(dirname -- "$manifest")" && pwd)/$(basename -- "$manifest")
test "$(wc -l < "$manifest_path" | tr -d ' ')" = 1 || { echo "Backup manifest must contain exactly one line" >&2; exit 1; }
manifest_checksum=$(awk 'NF==2 {print $1}' "$manifest_path")
manifest_name=$(awk 'NF==2 {print $2}' "$manifest_path")
printf '%s' "$manifest_checksum" | grep -Eq '^[0-9a-f]{64}$' || { echo "Backup manifest checksum is invalid" >&2; exit 1; }
test "$manifest_name" = "$(basename "$backup")" || { echo "Backup manifest filename does not match backup" >&2; exit 1; }
(cd "$backup_dir" && printf '%s  %s\n' "$manifest_checksum" "$manifest_name" | sha256sum --check --strict -)
archive=$backup
case "$backup" in
  *.age)
    test -n "$identity" || { echo "AGE_IDENTITY_FILE is required to inspect an encrypted backup" >&2; exit 2; }
    test -s "$identity"
    command -v age >/dev/null
    verify_tmp=$(mktemp -d "${TMPDIR:-/tmp}/reliacode-verify.XXXXXX")
    trap 'rm -rf -- "$verify_tmp"' EXIT HUP INT TERM
    archive="$verify_tmp/backup.dump"
    age --decrypt --identity "$identity" --output "$archive" "$backup"
    ;;
esac
pg_restore --list "$archive" >/dev/null
printf 'PASS ciphertext checksum and decrypted pg_restore archive inspection: %s\n' "$backup"
