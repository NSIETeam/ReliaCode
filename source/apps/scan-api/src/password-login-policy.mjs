import { ADMIN_PASSKEY_ROLES } from './passkey-policy.mjs';

const OPERATOR_PASSWORD_ROLES = new Set(['FACTORY_OPERATOR','DISTRIBUTOR_RECEIVER','STORE_RECEIVER']);

export function passwordLoginAllowed(user) {
  if (!user) return true;
  const role=String(user.role||'').toUpperCase();
  if (ADMIN_PASSKEY_ROLES.has(role) && Number(user.passkey_count)>=2) return false;
  if (OPERATOR_PASSWORD_ROLES.has(role) && user.password_login_for_operators===false) return false;
  return true;
}
