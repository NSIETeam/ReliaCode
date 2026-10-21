ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS auth_method text,
  ADD COLUMN IF NOT EXISTS ip_hash text,
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'LOW',
  ADD COLUMN IF NOT EXISTS rotated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by text,
  ADD COLUMN IF NOT EXISTS revocation_reason text;

ALTER TABLE admin_sessions DROP CONSTRAINT IF EXISTS admin_sessions_auth_method_check;
ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_auth_method_check
  CHECK (auth_method IS NULL OR auth_method IN ('PASSWORD','PASSKEY','RECOVERY_CODE'));
ALTER TABLE admin_sessions DROP CONSTRAINT IF EXISTS admin_sessions_risk_level_check;
ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_risk_level_check
  CHECK (risk_level IN ('LOW','MEDIUM','HIGH'));
CREATE INDEX IF NOT EXISTS admin_sessions_active_user_idx
  ON admin_sessions(user_id,last_seen_at DESC) WHERE revoked_at IS NULL;

UPDATE admin_sessions s SET tenant_id=u.tenant_id
FROM local_users u WHERE s.user_id=u.id AND s.tenant_id IS NULL;

CREATE TABLE IF NOT EXISTS authentication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid REFERENCES local_users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('LOGIN_SUCCEEDED','LOGIN_RISK_DETECTED','SESSION_ROTATED','SESSION_REVOKED','ACCOUNT_FROZEN','ACCOUNT_UNFROZEN')),
  auth_method text,
  risk_level text NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  ip_hash text,
  user_agent text,
  actor_id text,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authentication_events_tenant_created_idx
  ON authentication_events(tenant_id,created_at DESC,id DESC);
DROP TRIGGER IF EXISTS authentication_events_append_only ON authentication_events;
CREATE TRIGGER authentication_events_append_only BEFORE UPDATE OR DELETE ON authentication_events
FOR EACH ROW EXECUTE FUNCTION reject_update_delete();
