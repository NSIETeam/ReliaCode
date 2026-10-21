export const ADMIN_PASSKEY_ROLES = new Set(["TENANT_OWNER","BRAND_ADMIN"]);

export function hasFreshPasskeyVerification(session,minutes,now=Date.now()) {
  const verifiedAt=Date.parse(String(session?.passkey_verified_at||""));
  return Number.isFinite(verifiedAt) && verifiedAt<=now && now-verifiedAt<=minutes*60_000;
}

export function requireFreshPasskeyVerification(request,config) {
  if(hasFreshPasskeyVerification(request.authSession,config.PASSKEY_STEP_UP_MINUTES))return;
  const error=new Error("A recent Passkey verification is required for this operation");
  error.statusCode=428;
  error.code="PASSKEY_STEP_UP_REQUIRED";
  throw error;
}
