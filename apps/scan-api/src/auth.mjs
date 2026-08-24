import { createRemoteJWKSet, jwtVerify } from "jose";

const roleCapabilities = {
  BRAND_ADMIN: ["codes:write", "objects:read", "events:read", "campaigns:write", "risks:review", "ledger:read"],
  BRAND_AUDITOR: ["objects:read", "events:read", "risks:review", "ledger:read"],
  FACTORY_OPERATOR: ["objects:read", "events:write:packing"],
  DISTRIBUTOR_RECEIVER: ["objects:read", "events:write:distributor_receiving"],
  STORE_RECEIVER: ["objects:read", "events:write:store_receiving", "ledger:read:self"],
  FINANCE: ["ledger:read", "settlements:write"]
};

function normalizePrincipal(payload) {
  const role = String(payload.role || payload["reliacode:role"] || "").toUpperCase();
  const tenantId = payload.tenant_id || payload["reliacode:tenant_id"];
  const organizationId = payload.organization_id || payload["reliacode:organization_id"];
  if (!payload.sub || !tenantId || !organizationId || !roleCapabilities[role]) return null;
  return {
    id: String(payload.sub),
    tenantId: String(tenantId),
    organizationId: String(organizationId),
    role,
    capabilities: new Set(roleCapabilities[role]),
    name: String(payload.name || payload.preferred_username || payload.sub)
  };
}

export async function createAuthenticator(config) {
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
