#!/bin/sh
set -eu

: "${RELEASE_SHA:?RELEASE_SHA is required}"
printf '%s' "$RELEASE_SHA" | grep -Eq '^[0-9a-f]{40}$' || { printf 'RELEASE_SHA must be a full lowercase 40-character Git SHA\n' >&2; exit 1; }

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$deploy_dir"

test -f .env
for secret_file in \
  secrets/database_url.txt \
  secrets/system_database_url.txt \
  secrets/migration_database_url.txt \
  secrets/openepcis_bearer_token.txt \
  secrets/object_storage_access_key_id.txt \
  secrets/object_storage_secret_access_key.txt \
  secrets/smtp_url.txt \
  secrets/metrics_bearer_token.txt \
  secrets/webhook_encryption_key.txt \
  secrets/session_fingerprint_key.txt \
  secrets/otel_exporter_headers.txt
do
  test -s "$secret_file"
  secret_mode=$(stat -c '%a' "$secret_file")
  [ "$secret_mode" = 400 ] || [ "$secret_mode" = 600 ] || { printf 'Secret file %s must have mode 0400 or 0600\n' "$secret_file" >&2; exit 1; }
done

export RELIACODE_API_IMAGE="ghcr.io/nsieteam/reliacode-api:sha-${RELEASE_SHA}"
export RELIACODE_WEB_IMAGE="ghcr.io/nsieteam/reliacode-web:sha-${RELEASE_SHA}"

compose="docker compose --env-file .env -f compose.production.yaml"

previous_api_image=""
previous_web_image=""
previous_release_sha=""
api_container=$($compose ps -q api 2>/dev/null || true)
web_container=$($compose ps -q web 2>/dev/null || true)
if [ -n "$api_container" ]; then
  previous_api_image=$(docker inspect --format '{{.Config.Image}}' "$api_container")
fi
if [ -n "$web_container" ]; then
  previous_web_image=$(docker inspect --format '{{.Config.Image}}' "$web_container")
fi
if { [ -n "$previous_api_image" ] && [ -z "$previous_web_image" ]; } || { [ -z "$previous_api_image" ] && [ -n "$previous_web_image" ]; }; then
  printf 'A partial previous release cannot provide a safe rollback target\n' >&2
  exit 1
fi
if [ -n "$previous_api_image" ]; then
  printf '%s' "$previous_api_image" | grep -Eq '^ghcr\.io/nsieteam/reliacode-api:sha-[0-9a-f]{40}$' || { printf 'Previous API image is not immutable\n' >&2; exit 1; }
  printf '%s' "$previous_web_image" | grep -Eq '^ghcr\.io/nsieteam/reliacode-web:sha-[0-9a-f]{40}$' || { printf 'Previous Web image is not immutable\n' >&2; exit 1; }
  previous_release_sha=${previous_api_image##*:sha-}
  [ "$previous_release_sha" = "${previous_web_image##*:sha-}" ] || { printf 'Previous API and Web images do not belong to the same release SHA\n' >&2; exit 1; }
fi

verify_release() {
  expected_sha=$1
  curl --fail --silent --show-error http://127.0.0.1:4180/health/ready >/dev/null || return 1
  api_live=$(curl --fail --silent --show-error http://127.0.0.1:4180/health/live) || return 1
  printf '%s' "$api_live" | grep -Fq "\"revision\":\"$expected_sha\"" || return 1
  $compose exec -T web /nodejs/bin/node -e "fetch('http://127.0.0.1:4173/health/live').then(r=>r.json()).then(x=>{if(x.status!=='ok'||x.revision!==process.argv[1])process.exit(1)}).catch(()=>process.exit(1))" "$expected_sha"
}

rollback() {
  if [ -z "$previous_api_image" ] || [ -z "$previous_web_image" ]; then
    printf 'No complete previous release is available for automatic rollback\n' >&2
    return 1
  fi
  printf 'Restoring previous application images: API=%s Web=%s\n' "$previous_api_image" "$previous_web_image" >&2
  export RELIACODE_API_IMAGE="$previous_api_image"
  export RELIACODE_WEB_IMAGE="$previous_web_image"
  $compose up -d --remove-orphans api outbox-worker code-worker code-export-worker reward-reconciliation-worker webhook-worker web
  rollback_attempt=1
  while [ "$rollback_attempt" -le 30 ]; do
    if verify_release "$previous_release_sha"; then
      printf 'Previous release restored successfully\n' >&2
      return 0
    fi
    rollback_attempt=$((rollback_attempt + 1))
    sleep 2
  done
  printf 'Automatic rollback failed health verification\n' >&2
  return 1
}

rollback_required=false
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$rollback_required" = true ]; then
    set +e
    rollback
    rollback_status=$?
    if [ "$rollback_status" -ne 0 ]; then
      printf 'Manual incident response is required after rollback failure\n' >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

$compose pull
$compose run --rm migrate
rollback_required=true
$compose up -d --remove-orphans api outbox-worker code-worker code-export-worker reward-reconciliation-worker webhook-worker web

attempt=1
while [ "$attempt" -le 30 ]; do
  if verify_release "$RELEASE_SHA"; then
    $compose ps
    printf 'ReliaCode release sha-%s is healthy\n' "$RELEASE_SHA"
    rollback_required=false
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

$compose ps
$compose logs --tail=100 api web outbox-worker code-worker code-export-worker reward-reconciliation-worker webhook-worker
printf 'ReliaCode release sha-%s failed health verification\n' "$RELEASE_SHA" >&2
exit 1
