# Single-admin persistent deployment

This MVP uses `AUTH_MODE=local`, a scrypt password hash in the environment, HttpOnly SameSite=Strict sessions, stable CSRF tokens and PostgreSQL JSONB workspace storage. Migration `004_admin_persistence.sql` also maintains a transactional public-verification projection, so newly generated codes can be verified anonymously. It does not use Keycloak or OpenEPCIS.

## Configuration

Set `ADMIN_PASSWORD_HASH` to the output of `node -e "import('./apps/scan-api/src/auth.mjs').then(({hashPassword})=>console.log(hashPassword(process.argv[1])) )" 'strong-password'` and never commit the value.

For the direct ECS IP HTTP entry, use `PUBLIC_ORIGINS=http://8.140.52.117`, `SESSION_COOKIE_SECURE=false` and `ALLOW_INSECURE_HTTP=true`. All three settings are required; HTTP exposes the session to interception. After the domain HTTPS entry is ready, set `PUBLIC_ORIGINS=https://reliacode.cn` and `SESSION_COOKIE_SECURE=true` (and remove the insecure opt-in).

Keep the API bound to loopback when Nginx is the public entry point (for example, publish only `127.0.0.1:4180:4180` or set `HOST=127.0.0.1`). If Nginx terminates TLS and forwards the original client address, set `TRUST_PROXY=true`; otherwise every visitor can appear as `127.0.0.1` and share the same IP rate-limit bucket. Only enable `TRUST_PROXY` when the API port is not directly reachable from the internet and the proxy path is controlled.

The production HTTPS configuration sends HSTS only when `SESSION_COOKIE_SECURE=true`. An explicitly enabled insecure HTTP bootstrap therefore does not pin the browser to HTTPS before the TLS entry is ready.

Set `persistentWorkspace=true` in `apps/scan-web/runtime-config.js` on the server-served build. Keep the repository default false for GitHub Pages.

Run the API migration before starting the service:

```sh
cd apps/scan-api
npm run migrate
npm start
```

## Backup and restore

```sh
pg_dump --format=custom --file=reliacode-$(date +%F).dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" reliacode-YYYY-MM-DD.dump
```

Backups must be encrypted, copied off-host and periodically restore-tested. The workspace row is `admin_workspaces`; sessions are short-lived hashes and are not backup material.

The API returns `409 WORKSPACE_VERSION_CONFLICT` when two browser sessions save the same version. Reload the newer workspace before continuing.
The first save uses `version=0` and stores version 0; each successful subsequent save increments it atomically.
