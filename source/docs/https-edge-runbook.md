# HTTPS edge runbook

The API should be exposed through an HTTPS reverse proxy. The repository includes an Nginx template at `deploy/nginx/reliacode-api.conf.example`; it is a reviewable starting point, not a production file. Nginx runs on the deployment host, so do not overwrite the host configuration from the repository or copy this template unattended.

## Configure the edge

1. Replace `api.example.com`, certificate paths, and the upstream port in a host-local copy of the template. Keep the API bound to `127.0.0.1:4180` (or an equivalent private network) so the HTTP API port cannot bypass the edge.
2. Create `/var/www/acme` and point the ACME client at it. The port-80 `/.well-known/acme-challenge/` location is deliberately served before the catch-all redirect; all other HTTP requests receive a `308` redirect to the same HTTPS host and path.
3. Obtain/renew the certificate with the approved ACME client, then validate and reload Nginx:

   ```sh
   sudo nginx -t
   sudo systemctl reload nginx
   ```

4. Verify that the HTTP redirect excludes ACME and that HSTS is emitted only on HTTPS:

   ```sh
   curl -sSI http://api.example.com/health/live
   curl -sSI https://api.example.com/health/live
   curl -sSI http://api.example.com/.well-known/acme/challenge/probe
   ```

The HTTPS response should contain `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`; the HTTP and ACME responses must not. Only use `includeSubDomains`/`preload` after confirming every covered subdomain supports HTTPS.

## API settings after TLS is ready

Set `PUBLIC_ORIGINS`/`CORS_ORIGINS` to the exact HTTPS frontend origins (comma-separated; no wildcard), set `SESSION_COOKIE_SECURE=true`, and remove `ALLOW_INSECURE_HTTP`. Set `TRUST_PROXY=true` only when the API is private and the trusted Nginx path is the sole public entry point.
