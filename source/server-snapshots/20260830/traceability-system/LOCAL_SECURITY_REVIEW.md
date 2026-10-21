# Local security review — 2026-08-30

This directory is a reviewed local copy of the production-pilot source. The live
server was not modified during this review.

## Fixed in this copy

- Removed reversible Base64 password persistence from browser `localStorage`.
- Rotate the session identifier after authentication and use a production
  `__Host-` cookie name.
- Removed the hard-coded session-secret fallback and require a persisted secret.
- Added application-level login throttling in addition to the Nginx limit.
- Added baseline CSP, clickjacking, MIME-sniffing, referrer and permissions
  response headers; disabled the Express signature header.
- Added request-body size limits.
- Constrained upload MIME types, generated extensions from an allow-list and
  replaced predictable filenames with cryptographically random names.
- Removed predictable production seed accounts. A first production start now
  requires `INITIAL_ADMIN_PASSWORD` with at least 12 characters.
- Escaped API-sourced values in the public verification and factory workbench
  dynamic HTML paths reviewed here.
- Upgraded Multer to 2.3.0 and overrode ExcelJS's transitive `uuid` dependency to
  a patched version. `npm audit --omit=dev` reports zero known vulnerabilities.
- Replaced active runtime Emoji icons with a monochrome SVG sprite.

## Remaining release blockers

- `express-session` still uses the in-process MemoryStore. Replace it with a
  durable, bounded store before multi-instance or general SaaS release.
- State-changing endpoints do not yet have explicit CSRF tokens or a consistent
  Origin check. SameSite cookies help, but are not the complete control.
- Several administration tables still build rows with `innerHTML`; all values
  returned from APIs should be rendered through DOM text nodes or a shared
  escaping helper before production expansion.
- SQLite/application filtering is not a substitute for database-enforced tenant
  isolation. The standard SaaS RLS plan remains required.
- Uploaded file content is restricted by declared MIME and extension, but deep
  magic-byte/content validation and malware scanning are still required for a
  public upload service.
- Inline scripts/styles require `unsafe-inline` in the current CSP. Move them to
  static assets or adopt per-request nonces before tightening CSP.

## Verification performed

- `node --check server.js` and `node --check database.js`.
- Local isolated login succeeded and rotated to a new session cookie.
- Read-only HTTP smoke checks returned 200 for the main administrator, business,
  alert, code, generation, settings, user, log, warehouse and factory pages.
- The SVG sprite returned `image/svg+xml` and active runtime source contained no
  Unicode Emoji in the reviewed files.
- Ten failed logins returned 401; the eleventh returned 429.
- Official npm registry audit: 0 known vulnerabilities.

