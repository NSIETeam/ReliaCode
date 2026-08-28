import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const ROLE_CAPABILITIES = Object.freeze({
  PLATFORM_OPERATOR: ["platform:tenants:read", "platform:tenants:write", "platform:audit:read"],
  TENANT_OWNER: ["tenant:manage", "products:write", "codes:write", "codes:approve", "objects:read", "events:read", "events:write:packing", "events:write:unpacking", "events:write:shipping", "events:write:returning", "events:write:selling", "events:write:destroying", "campaigns:write", "risks:review", "recalls:write", "ledger:read", "members:read", "members:invite", "members:manage", "relationships:write", "locations:write", "devices:write", "documents:write", "integrations:write", "integrations:approve"],
  BRAND_ADMIN: ["products:write", "codes:write", "codes:approve", "objects:read", "events:read", "events:write:packing", "events:write:unpacking", "events:write:shipping", "events:write:returning", "events:write:selling", "events:write:destroying", "campaigns:write", "risks:review", "recalls:write", "ledger:read", "members:read", "members:invite", "members:manage", "relationships:write", "locations:write", "devices:write", "documents:write", "integrations:write"],
  BRAND_AUDITOR: ["objects:read", "events:read", "risks:review", "ledger:read"],
  FACTORY_OPERATOR: ["objects:read", "events:write:packing", "events:write:unpacking", "events:write:shipping", "events:write:destroying"],
  DISTRIBUTOR_RECEIVER: ["objects:read", "events:write:distributor_receiving", "events:write:shipping", "events:write:returning"],
  STORE_RECEIVER: ["objects:read", "events:write:store_receiving", "events:write:returning", "events:write:selling", "ledger:read:self"],
  FINANCE: ["ledger:read", "settlements:write"],
  READ_ONLY_AUDITOR: ["objects:read", "events:read", "ledger:read"]
});
export const ROLES = Object.freeze(Object.keys(ROLE_CAPABILITIES));

function normalizePrincipal(payload) {
  const role = String(payload.role || payload["reliacode:role"] || "").toUpperCase();
  const tenantId = payload.tenant_id || payload["reliacode:tenant_id"];
  const organizationId = payload.organization_id || payload["reliacode:organization_id"];
  if (!payload.sub || !tenantId || !organizationId || !ROLE_CAPABILITIES[role]) return null;
  return {
    id: String(payload.sub),
    tenantId: String(tenantId),
    organizationId: String(organizationId),
    role,
    capabilities: new Set(ROLE_CAPABILITIES[role]),
    name: String(payload.name || payload.preferred_username || payload.sub),
    email: payload.email ? String(payload.email) : null,
    organizationName: payload.organization_name ? String(payload.organization_name) : null
  };
}

export async function createAuthenticator(config) {
  if (config.AUTH_MODE === 'local') {
    return async (request) => {
      const token = readCookie(request.headers.cookie, config.SESSION_COOKIE_NAME);
      if (!token) return null;
      const result = await config.db.query(
        'SELECT token_hash,csrf_token_hash,user_id,expires_at FROM admin_sessions WHERE token_hash=$1 AND expires_at > now()',
        [hashToken(token)]
      );
      if (!result.rowCount) return null;
      request.authSession = result.rows[0];
      if (result.rows[0].user_id) {
        const user = await config.db.query(
          'SELECT id,username,email,tenant_id,organization_id,role FROM local_users WHERE id=$1 AND status=\'ACTIVE\'',
          [result.rows[0].user_id]
        );
        if (!user.rowCount) return null;
        const row = user.rows[0];
        const membership = await config.db.query(
          `SELECT m.organization_id,m.role,o.name organization_name
           FROM local_memberships m JOIN local_organizations o ON o.id=m.organization_id
           JOIN tenants t ON t.id=o.tenant_id
           WHERE m.user_id=$1 AND m.status='ACTIVE' AND o.status='ACTIVE'
             AND t.status='ACTIVE'
           ORDER BY m.created_at ASC LIMIT 1`,
          [row.id]
        );
        if (!membership.rowCount) return null;
        const member = membership.rows[0];
        const role = String(member.role || row.role || 'BRAND_ADMIN').toUpperCase();
        if (!ROLE_CAPABILITIES[role]) return null;
        return {
          id:String(row.id), tenantId:String(row.tenant_id), organizationId:String(member.organization_id),
          role, capabilities:new Set(ROLE_CAPABILITIES[role]), name:String(row.username), email:String(row.email || ''), organizationName:String(member.organization_name || '')
        };
      }
      return {
        id: 'local-admin',
        tenantId: config.ADMIN_TENANT_ID,
        organizationId: config.ADMIN_ORGANIZATION_ID,
        role: 'PLATFORM_OPERATOR',
        capabilities: new Set(ROLE_CAPABILITIES.PLATFORM_OPERATOR),
        name: config.ADMIN_USERNAME
      };
    };
  }
  if (config.AUTH_MODE === "development") {
    return async (request) => {
      const raw = request.headers["x-reliacode-principal"];
      if (!raw) return null;
      try { return normalizePrincipal(JSON.parse(String(raw))); } catch { return null; }
    };
  }
  const issuer = new URL(config.OIDC_ISSUER_URL);
  const discoveryUrl = new URL(`${issuer.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`, issuer.origin);
  const discoveryResponse = await fetch(discoveryUrl, { signal:AbortSignal.timeout(10_000) });
  if (!discoveryResponse.ok) throw new Error(`OIDC discovery failed with ${discoveryResponse.status}`);
  const discovery = await discoveryResponse.json();
  const expectedIssuer = issuer.href.replace(/\/$/, "");
  if (String(discovery.issuer).replace(/\/$/, "") !== expectedIssuer || !discovery.jwks_uri) {
    throw new Error("OIDC discovery document does not match the configured issuer");
  }
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  return async (request) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return null;
    const { payload } = await jwtVerify(authorization.slice(7), jwks, {
      issuer: expectedIssuer,
      audience: config.OIDC_AUDIENCE,
      algorithms: ["RS256", "ES256"]
    });
    return normalizePrincipal(payload);
  };
}

export function requireCapability(principal, capability) {
  if (!principal?.capabilities.has(capability)) {
    const error = new Error("Insufficient permission");
    error.statusCode = 403;
    error.code = "FORBIDDEN";
    throw error;
  }
}

export function requireAnyCapability(principal, capabilities) {
  const allowed = Array.isArray(capabilities) && capabilities.some((capability) => principal?.capabilities.has(capability));
  if (!allowed) {
    const error = new Error("Insufficient permission");
    error.statusCode = 403;
    error.code = "FORBIDDEN";
    throw error;
  }
}

export function readCookie(header, name) {
  const prefix = name + '=';
  return String(header || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) || null;
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function verifyPassword(password, encoded) {
  try {
    const [scheme, nRaw, rRaw, pRaw, saltHex, digestHex] = String(encoded || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !digestHex) return false;
    const N=Number(nRaw), r=Number(rRaw), p=Number(pRaw);
    if (!Number.isInteger(N) || N < 16_384 || N > 1_048_576 || (N & (N - 1)) !== 0 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
    if (!/^[0-9a-f]{32,128}$/i.test(saltHex) || !/^[0-9a-f]{64}$/i.test(digestHex)) return false;
    const digest = scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32, { N, r, p, maxmem:128 * 1024 * 1024 });
    const expected = Buffer.from(digestHex, 'hex');
    return expected.length === digest.length && timingSafeEqual(expected, digest);
  } catch { return false; }
}

export function hashPassword(password, { N=16_384, r=8, p=1 } = {}) {
  const salt = randomBytes(16);
  const digest = scryptSync(String(password), salt, 32, { N, r, p, maxmem:64 * 1024 * 1024 });
  return 'scrypt$' + N + '$' + r + '$' + p + '$' + salt.toString('hex') + '$' + digest.toString('hex');
}

export function newSessionToken() { return randomBytes(32).toString('base64url'); }
