#!/bin/sh
set -eu

: "${RELEASE_SHA:?RELEASE_SHA is required}"

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$deploy_dir"

test -f .env
test -s secrets/database_url.txt
test -s secrets/migration_database_url.txt

export RELIACODE_API_IMAGE="ghcr.io/nsieteam/reliacode-api:sha-${RELEASE_SHA}"
export RELIACODE_WEB_IMAGE="ghcr.io/nsieteam/reliacode-web:sha-${RELEASE_SHA}"

compose="docker compose --env-file .env -f compose.production.yaml"
$compose pull
$compose run --rm migrate
$compose up -d --remove-orphans api outbox-worker code-worker code-export-worker webhook-worker web

attempt=1
while [ "$attempt" -le 30 ]; do
  if curl --fail --silent --show-error http://127.0.0.1:4180/health/ready >/dev/null && \
     $compose exec -T web node -e "fetch('http://127.0.0.1:4173/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
    $compose ps
    printf 'ReliaCode release sha-%s is healthy\n' "$RELEASE_SHA"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

$compose ps
$compose logs --tail=100 api web outbox-worker code-worker code-export-worker webhook-worker
printf 'ReliaCode release sha-%s failed health verification\n' "$RELEASE_SHA" >&2
exit 1
