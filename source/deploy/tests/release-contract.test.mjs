import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/production-release.yml', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../compose.production.yaml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../release.sh', import.meta.url), 'utf8');
const webDockerfile = readFileSync(new URL('../../apps/scan-web/Dockerfile', import.meta.url), 'utf8');
const apiDockerfile = readFileSync(new URL('../../apps/scan-api/Dockerfile', import.meta.url), 'utf8');
const npmrc = readFileSync(new URL('../../.npmrc', import.meta.url), 'utf8');
const nginx = readFileSync(new URL('../nginx/reliacode-api.conf.example', import.meta.url), 'utf8');
const alerts = readFileSync(new URL('../monitoring/reliacode-alerts.yml', import.meta.url), 'utf8');

test('production publishes SHA images only and scans both runtime images', () => {
  assert.doesNotMatch(workflow, /IMAGE \}\}:latest/);
  assert.match(workflow, /image-ref: reliacode-api:scan/);
  assert.match(workflow, /image-ref: reliacode-web:scan/);
  assert.equal((workflow.match(/severity: HIGH,CRITICAL/g) || []).length, 2);
});

test('production release is manual and remains protected by its environment', () => {
  const triggerBlock = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('\n\npermissions:'));
  assert.match(triggerBlock, /workflow_dispatch:/);
  assert.doesNotMatch(triggerBlock, /push:/);
  assert.match(workflow, /environment: production/);
});

test('failed releases restore the complete previous immutable image set', () => {
  assert.match(release, /previous_api_image=.*docker inspect/);
  assert.match(release, /previous_web_image=.*docker inspect/);
  assert.match(release, /rollback\(\)/);
  assert.match(release, /trap on_exit EXIT/);
  assert.match(release, /rollback_required=true/);
  assert.match(release, /rollback_required=false/);
  assert.match(release, /Previous release restored successfully/);
});

test('a partial compose-up failure executes rollback with the previous images', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reliacode-release-test-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  const bin = join(root, 'bin');
  const secrets = join(root, 'secrets');
  mkdirSync(bin);
  mkdirSync(secrets);
  cpSync(new URL('../release.sh', import.meta.url), join(root, 'release.sh'));
  chmodSync(join(root, 'release.sh'), 0o700);
  writeFileSync(join(root, '.env'), '# test only\n');
  writeFileSync(join(root, 'compose.production.yaml'), 'services: {}\n');
  for (const name of ['database_url','system_database_url','migration_database_url','openepcis_bearer_token','object_storage_access_key_id','object_storage_secret_access_key','smtp_url','metrics_bearer_token','webhook_encryption_key','session_fingerprint_key','otel_exporter_headers']) {
    const path=join(secrets,`${name}.txt`);
    writeFileSync(path,'test-only\n');
    chmodSync(path,0o600);
  }
  const oldApiSha = 'a'.repeat(40);
  const oldWebSha = oldApiSha;
  const newSha = 'c'.repeat(40);
  const docker = `#!/bin/sh
printf '%s|%s|docker %s\\n' "$RELIACODE_API_IMAGE" "$RELIACODE_WEB_IMAGE" "$*" >> "$MOCK_LOG"
if [ "$1" = inspect ]; then
  case "$4" in api-old) echo ghcr.io/nsieteam/reliacode-api:sha-${oldApiSha};; web-old) echo ghcr.io/nsieteam/reliacode-web:sha-${oldWebSha};; esac
  exit 0
fi
case "$*" in
  *"ps -q api") echo api-old;;
  *"ps -q web") echo web-old;;
  *"up -d"*) if [ ! -f "$MOCK_STATE" ]; then : > "$MOCK_STATE"; exit 42; fi;;
esac
exit 0
`;
  writeFileSync(join(bin, 'docker'), docker);
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '{"status":"ready","revision":"${oldApiSha}"}'\nexit 0\n`);
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(bin, 'stat'), '#!/bin/sh\nprintf "600\\n"\n');
  for (const name of ['docker','curl','sleep','stat']) chmodSync(join(bin, name), 0o700);
  const log = join(root, 'commands.log');
  const result = spawnSync('/bin/sh', [join(root, 'release.sh')], {
    env:{ ...process.env, PATH:`${bin}:${process.env.PATH}`, RELEASE_SHA:newSha, MOCK_LOG:log, MOCK_STATE:join(root, 'failed-once') },
    encoding:'utf8'
  });
  assert.equal(result.status, 42);
  const commands = readFileSync(log, 'utf8');
  assert.match(commands, new RegExp(`reliacode-api:sha-${newSha}\\|ghcr\\.io/nsieteam/reliacode-web:sha-${newSha}\\|docker compose .* up -d`));
  assert.match(commands, new RegExp(`reliacode-api:sha-${oldApiSha}\\|ghcr\\.io/nsieteam/reliacode-web:sha-${oldWebSha}\\|docker compose .* up -d`));
  assert.match(result.stderr, /Previous release restored successfully/);
});

test('release preflight requires every mounted production secret', () => {
  for (const name of [
    'database_url',
    'system_database_url',
    'migration_database_url',
    'openepcis_bearer_token',
    'object_storage_access_key_id',
    'object_storage_secret_access_key',
    'smtp_url',
    'metrics_bearer_token',
    'webhook_encryption_key',
    'session_fingerprint_key',
    'otel_exporter_headers'
  ]) assert.match(release, new RegExp(`secrets/${name}\\.txt`));
  assert.match(release,/Secret file %s must have mode 0400 or 0600/);
});

test('release accepts only full immutable Git SHA image references', () => {
  assert.match(release, /RELEASE_SHA must be a full lowercase 40-character Git SHA/);
  assert.match(release, /reliacode-api:sha-\[0-9a-f\]\{40\}/);
  assert.match(release, /reliacode-web:sha-\[0-9a-f\]\{40\}/);
  assert.match(release, /A partial previous release cannot provide a safe rollback target/);
  assert.match(release, /Previous API and Web images do not belong to the same release SHA/);
  assert.match(release, /verify_release "\$RELEASE_SHA"/);
  assert.match(release, /revision.*expected_sha/);
});

test('production containers are hardened and host ports stay loopback-only', () => {
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.match(compose, /"no-new-privileges:true"/);
  assert.match(compose, /"127\.0\.0\.1:4180:4180"/);
  assert.match(compose, /"127\.0\.0\.1:\$\{WEB_PORT:-4173\}:4173"/);
  assert.doesNotMatch(compose, /:latest/);
  assert.match(compose, /RELIACODE_API_IMAGE:\?RELIACODE_API_IMAGE must be an immutable sha tag/);
  assert.match(compose, /RELIACODE_WEB_IMAGE:\?RELIACODE_WEB_IMAGE must be an immutable sha tag/);
  assert.match(compose, /DATABASE_SSL: "true"/);
  assert.match(compose, /SYSTEM_DATABASE_URL_FILE: \/run\/secrets\/system_database_url/);
  assert.match(compose, /TENANT_DATABASE_ROLE: \$\{TENANT_DATABASE_ROLE:\?TENANT_DATABASE_ROLE is required\}/);
  assert.match(compose, /SYSTEM_DATABASE_ROLE: \$\{SYSTEM_DATABASE_ROLE:\?SYSTEM_DATABASE_ROLE is required\}/);
  assert.match(compose, /SESSION_COOKIE_NAME: __Host-reliacode_session/);
  assert.match(compose, /CSRF_COOKIE_NAME: __Host-reliacode_csrf/);
  assert.match(compose, /METRICS_BEARER_TOKEN_FILE: \/run\/secrets\/metrics_bearer_token/);
  assert.match(compose, /WEBHOOK_ENCRYPTION_KEY_FILE: \/run\/secrets\/webhook_encryption_key/);
  assert.match(compose, /SESSION_FINGERPRINT_KEY_FILE: \/run\/secrets\/session_fingerprint_key/);
  assert.match(compose, /OTEL_EXPORTER_OTLP_HEADERS_FILE: \/run\/secrets\/otel_exporter_headers/);
  assert.match(compose, /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: \$\{OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:\?OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is required\}/);
  assert.doesNotMatch(compose, /^\s+(?:METRICS_BEARER_TOKEN|WEBHOOK_ENCRYPTION_KEY|SESSION_FINGERPRINT_KEY):/m);
});

test('Web runtime is distroless non-root and receives a fixed public origin', () => {
  assert.match(webDockerfile, /distroless\/nodejs24-debian13:nonroot/);
  assert.match(webDockerfile, /USER nonroot/);
  assert.match(webDockerfile, /ARG APP_VERSION=development/);
  assert.match(webDockerfile, /ARG GIT_SHA=unknown/);
  assert.match(compose, /RELIACODE_PUBLIC_ORIGIN: \$\{PUBLIC_ORIGIN:\?PUBLIC_ORIGIN is required\}/);
  assert.equal((workflow.match(/APP_VERSION=sha-\$\{\{ github\.sha \}\}/g)||[]).length,4);
  assert.equal((workflow.match(/GIT_SHA=\$\{\{ github\.sha \}\}/g)||[]).length,4);
});

test('API image installs the exact root lockfile tested by CI', () => {
  assert.match(apiDockerfile, /COPY package\.json package-lock\.json \.npmrc/);
  assert.match(apiDockerfile, /npm ci --omit=dev --workspace @reliacode\/scan-api/);
  assert.match(apiDockerfile, /\/app\/apps\/scan-api\/node_modules \.\/node_modules/);
  assert.doesNotMatch(apiDockerfile, /COPY package\.json package-lock\.json \.\/\nRUN npm ci --omit=dev\n/);
  assert.equal((workflow.match(/context: \./g)||[]).length>=2,true);
  assert.equal((workflow.match(/file: apps\/scan-api\/Dockerfile/g)||[]).length,2);
});

test('dependency lifecycle scripts are denied unless explicitly reviewed', () => {
  assert.match(npmrc, /^strict-allow-scripts=true$/m);
  assert.match(npmrc, /^allow-scripts=protobufjs$/m);
  assert.doesNotMatch(npmrc, /dangerously-allow-all-scripts=true/);
});

test('edge proxy uses the same-origin Web entrypoint and a fixed canonical host', () => {
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:4173/);
  assert.match(nginx, /return 308 https:\/\/reliacode\.example\.com\$request_uri/);
  assert.match(nginx, /proxy_set_header Host reliacode\.example\.com/);
  assert.doesNotMatch(nginx, /https:\/\/\$host/);
});

test('production alert rules cover latency, errors, queues, database and backups', () => {
  for (const name of [
    'ReliaCodeHttpP95High',
    'ReliaCodeHttpErrorRateHigh',
    'ReliaCodeEpcisBacklogOld',
    'ReliaCodeEpcisDeadLetters',
    'ReliaCodeDatabasePoolWaiting',
    'ReliaCodeBackupMissingOrStale',
    'ReliaCodeWebhookDeadLetters',
    'ReliaCodeCodeExportDeadLetters',
    'ReliaCodeRewardReconciliationBacklog',
    'ReliaCodeRewardReconciliationDeadLetters'
  ]) assert.match(alerts, new RegExp(`alert: ${name}`));
  assert.match(alerts, /reliacode_epcis_oldest_pending_age_seconds > 300/);
  assert.match(alerts, /reliacode_backup_age_seconds > 86400/);
  assert.match(alerts, /reliacode_reward_reconciliation_dead_letters > 0/);
});

test('reward reconciliation worker participates in deploy, rollback, diagnostics and CI syntax gates', () => {
  assert.equal((release.match(/reward-reconciliation-worker/g)||[]).length >= 3, true);
  assert.match(compose, /reward-reconciliation-worker:/);
  assert.match(workflow, /node --check apps\/scan-api\/src\/reward-reconciliation-worker\.mjs/);
});
